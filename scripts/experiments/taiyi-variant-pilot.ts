#!/usr/bin/env tsx
/**
 * 太一提示词变体对照 runner（实验文档阶段1：A 完整 vs C 精简）
 *
 * 用法：
 *   npx tsx scripts/experiments/taiyi-variant-pilot.ts \
 *     --variant A|C \
 *     --suite docs/experiments/2026-10-07-test-tasks/taiyi-pilot-suite.json \
 *     --workspace <isolated dir> \
 *     --provider deepseek --model deepseek-flash \
 *     --store-file docs/experiments/2026-10-07-taiyi-pilot-runs.jsonl \
 *     [--task <id>] [--max-turns 20] [--dry-run]
 *
 * 设计（为什么不用 scripts/run-benchmark.ts）：
 *   run-benchmark 只能装配工具档（RIVET_TOOL_PRESET），无法激活太一「域提示词」——
 *   域由配置 defaultDomain 经 bindSessionDomain 消费，CLI 无 --domain 开关。
 *   本 runner 直接构造 AgentLoop 并 setSessionDomain(变体 def)，对 volatileBlock
 *   的注入路径与生产 <star-domain> 渲染逐字节等价（volatile.ts:1190）。
 *
 * 变体不经 star-domain-data.ts，避免污染生产提示词与守护测试。
 * 指标直接从 AgentCallbacks 采集（直接构造的 AgentLoop 不接线会话持久化）。
 */

import { parseArgs } from 'node:util'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { loadTaskSuite } from '../../src/benchmark/task-suite.js'
import { taiyiVariantDomain, variantMarker, type TaiyiVariant } from './taiyi-variants.js'
import type { AgentCallbacks } from '../../src/agent/loop.js'
import type { Usage } from '../../src/api/types.js'
import type { TaskDefinition } from '../../src/benchmark/types.js'

/** 只读工具（与实验文档 C 指标口径一致：grep/read 系）。bash/git 保守归入非只读。 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'ast_grep', 'repo_map', 'read_section',
  'inspect_project', 'git_scout', 'semantic_search', 'related_tests',
  'file_info', 'recall_capsule', 'memory', 'skill', 'ask_image',
])

/** 太一期望认知模式的关键词（守黑/观复/取证），用于扫描 agent 输出文本。 */
const POSTURE_KEYWORDS = {
  guardBlack: ['依赖', '约定', '影响面', '调用方', '消费者', '波及', '上游', '下游'],
  observeReturn: ['复现', '回归', '再来一次', '第二次', '往复', '重连', '恢复'],
  evidence: ['证据', '取证', '相邻行', '时间戳', '磁盘', '文件:', '行:'],
}

interface RunRecord {
  variant: TaiyiVariant
  taskId: string
  runIndex: number
  provider: string
  model: string
  status: 'ok' | 'error' | 'timeout'
  error?: string
  turns: number
  toolCalls: number
  toolSequence: string[]
  /** 工具调用实参摘要（轨迹用）：每条 name(compact arg)。 */
  toolDetail: string[]
  readOnlyToolCalls: number
  readOnlyRatio: number
  readBeforeWrite: number | null
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheCreation: number
  tokensReasoning: number
  thinkingChars: number
  textChars: number
  postureHits: { guardBlack: number; observeReturn: number; evidence: number }
  variantBlockChars: number
  markerSeenInText: boolean
  durationMs: number
  /** 跑完后工作区的 git diff --stat（**只含未暂存**——agent 若自行 commit 会漏记，用 commitsSinceBase 补齐）。 */
  diffStat: string
  /** agent 在基线之上新建的提交（--base-ref 给定时采集）。空 = 未提交。 */
  commitsSinceBase?: string[]
  /** 评分命令退出码（未配置评分命令时 undefined）。 */
  gradeExit?: number
  /** 评分命令输出的尾部（失败诊断用）。 */
  gradeTail?: string
  text: string
}

const { values } = parseArgs({
  options: {
    variant: { type: 'string' },
    suite: { type: 'string' },
    workspace: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'store-file': { type: 'string' },
    'max-turns': { type: 'string' },
    'run-index': { type: 'string' },
    'grade-cmd': { type: 'string' },
    'base-ref': { type: 'string' },
    task: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
})

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

if (values.help) {
  console.log('taiyi-variant-pilot — A/C 变体对照 runner。见文件头注释。')
  process.exit(0)
}

interface RunOpts {
  variant: TaiyiVariant
  runIndex: number
  provider: string
  model: string
  workspace: string
  maxTurns: number
  gradeCmd?: string
  baseRef?: string
}

/** 从工具入参里取一个最具辨识度的实参（轨迹可读性），截断到 90 字符。 */
function compactArg(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['file_path', 'path', 'command', 'pattern', 'cmd', 'query', 'objective', 'glob']) {
    const v = input[key]
    if (typeof v === 'string' && v) return v.replace(/\s+/g, ' ').slice(0, 90)
  }
  return ''
}

async function runTask(task: TaskDefinition, opts: RunOpts): Promise<RunRecord> {
  const { AgentLoop } = await import('../../src/agent/loop.js')
  const { SessionContext } = await import('../../src/agent/context.js')
  const { createDefaultToolRegistry } = await import('../../src/tools/default-registry.js')
  const { createAgentConfig, createMainAgentConfigInput } = await import('../../src/agent/create-agent-config.js')
  const { loadConfig } = await import('../../src/config/manager.js')
  const { setTargetConventions, applyConfiguredGitBashPath } = await import('../../src/platform.js')

  const cfg = loadConfig()
  setTargetConventions(cfg.editor.platform, cfg.editor.eol)
  applyConfiguredGitBashPath(cfg.env.gitBashPath)
  // 无人在环：跳过审批（实验无交互）。config.agent.approval 是 createMainAgentConfigInput 的真实来源。
  cfg.agent.approval = 'dangerously-skip-permissions'

  const prov = cfg.provider.providers[opts.provider]
  if (!prov) throw new Error(`provider '${opts.provider}' 未配置`)
  const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
  if (!key) throw new Error(`provider '${opts.provider}' 无 apiKey（provider-keys.json 未注入？）`)
  const model = prov.models.find(m => m.id === opts.model)
  if (!model) throw new Error(`provider '${opts.provider}' 无模型 '${opts.model}'`)

  const variantDomain = taiyiVariantDomain(opts.variant)
  const marker = variantMarker(opts.variant)
  const toolRegistry = createDefaultToolRegistry([], {
    preset: 'taiyi', // 与生产太一内置档一致（评测档 14 件）
    desktopTools: cfg.agent.desktopTools,
  })

  const sessionId = randomUUID()
  const agentCfg = createAgentConfig(createMainAgentConfigInput({
    apiKey: key,
    model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
    cwd: opts.workspace,
    provider: prov,
    allProviders: cfg.provider.providers,
    config: cfg,
    sessionId,
    toolDefinitions: toolRegistry.getDefinitions(),
    sessionMemoryBlock: undefined,
    auth: undefined,
  }))
  const session = new SessionContext()
  const agent = new AgentLoop({ ...agentCfg, toolRegistry, maxTurns: opts.maxTurns }, session, opts.workspace)
  agent.setSessionDomain(variantDomain)

  let text = ''
  let thinking = ''
  const toolSequence: string[] = []
  const toolDetail: string[] = []
  let turns = 0
  let lastUsage: Partial<Usage> | undefined
  let error: string | undefined

  const callbacks: AgentCallbacks = {
    onTextDelta: d => { text += d },
    onThinkingDelta: d => { thinking += d },
    onToolUse: (_id, name, input) => { toolSequence.push(name); toolDetail.push(`${name}(${compactArg(input)})`) },
    onToolResult: () => {},
    onTurnComplete: usage => { turns++; if (usage) lastUsage = usage },
    onError: e => { error = error ?? e.message },
    onAbort: () => { error = error ?? 'aborted' },
    onApprovalRequired: async () => false,
  }

  const started = Date.now()
  let status: RunRecord['status'] = 'ok'
  const guard: Promise<boolean> = new Promise(resolve => {
    const t = setTimeout(resolve, task.timeoutMs, true)
    if (typeof t.unref === 'function') t.unref()
  })
  try {
    const run = agent.run(task.prompt, callbacks).then(() => false)
    const timedOut = await Promise.race([run, guard])
    if (timedOut) { status = 'timeout'; error = error ?? `timeout after ${task.timeoutMs}ms` }
    else if (error) status = 'error'
  } catch (e) {
    status = 'error'
    error = (e as Error).message
  }
  const durationMs = Date.now() - started

  // 真实任务的产出证据：工作区 diff + 评分命令退出码（不信 agent 自述）
  let diffStat = ''
  try {
    diffStat = execFileSync('git', ['diff', '--stat'], { cwd: opts.workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }).trim()
  } catch (e) { diffStat = `(git diff 失败: ${(e as Error).message.slice(0, 120)})` }

  // agent 自行 commit 时 diffStat 为空——用 base..HEAD 的提交补齐产出证据
  let commitsSinceBase: string[] | undefined
  if (opts.baseRef) {
    try {
      const out = execFileSync('git', ['log', '--oneline', `${opts.baseRef}..HEAD`], { cwd: opts.workspace, encoding: 'utf8', windowsHide: true })
      commitsSinceBase = out.trim().split('\n').filter(Boolean)
    } catch { commitsSinceBase = [] }
  }
  let gradeExit: number | undefined
  let gradeTail: string | undefined
  if (opts.gradeCmd) {
    try {
      const out = execFileSync('bash', ['-lc', opts.gradeCmd], { cwd: opts.workspace, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
      gradeExit = 0
      gradeTail = out.trim().split('\n').slice(-14).join('\n')
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      gradeExit = err.status ?? 1
      gradeTail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-14).join('\n')
    }
  }

  const u = lastUsage ?? {}
  const readOnlyToolCalls = toolSequence.filter(n => READ_ONLY_TOOLS.has(n)).length
  const countHits = (kws: string[]) => kws.reduce((acc, kw) => acc + (text.split(kw).length - 1), 0)

  return {
    variant: opts.variant,
    taskId: task.id,
    runIndex: opts.runIndex,
    provider: opts.provider,
    model: opts.model,
    status,
    error,
    turns,
    toolCalls: toolSequence.length,
    toolSequence,
    toolDetail,
    readOnlyToolCalls,
    readOnlyRatio: toolSequence.length ? readOnlyToolCalls / toolSequence.length : 0,
    readBeforeWrite: null,
    tokensInput: u.input_tokens ?? 0,
    tokensOutput: u.output_tokens ?? 0,
    tokensCacheRead: u.cache_read_input_tokens ?? 0,
    tokensCacheCreation: u.cache_creation_input_tokens ?? 0,
    tokensReasoning: u.reasoning_tokens ?? 0,
    thinkingChars: thinking.length,
    textChars: text.length,
    postureHits: {
      guardBlack: countHits(POSTURE_KEYWORDS.guardBlack),
      observeReturn: countHits(POSTURE_KEYWORDS.observeReturn),
      evidence: countHits(POSTURE_KEYWORDS.evidence),
    },
    variantBlockChars: variantDomain.volatileBlock.length,
    markerSeenInText: text.includes(marker),
    durationMs,
    diffStat,
    ...(commitsSinceBase !== undefined ? { commitsSinceBase } : {}),
    ...(gradeExit !== undefined ? { gradeExit } : {}),
    ...(gradeTail !== undefined ? { gradeTail } : {}),
    text,
  }
}

async function main(): Promise<void> {
  const variant = (str(values.variant) ?? 'A') as TaiyiVariant
  if (variant !== 'A' && variant !== 'C') {
    console.error('Error: --variant 必须是 A 或 C')
    process.exit(1)
  }
  const suitePath = str(values.suite)
  if (!suitePath) { console.error('Error: --suite 必填'); process.exit(1) }
  const suite = loadTaskSuite(suitePath)
  const taskFilter = str(values.task)
  const tasks = taskFilter ? suite.tasks.filter(t => t.id === taskFilter) : suite.tasks
  if (tasks.length === 0) { console.error('Error: 无匹配任务'); process.exit(1) }

  const provider = str(values.provider) ?? 'deepseek'
  const model = str(values.model) ?? 'deepseek-flash'
  const workspace = resolve(str(values.workspace) ?? '.')
  if (!existsSync(workspace)) { console.error(`Error: workspace 不存在: ${workspace}`); process.exit(1) }
  const storeFile = resolve(str(values['store-file']) ?? 'docs/experiments/2026-10-07-taiyi-pilot-runs.jsonl')
  const maxTurns = Number(str(values['max-turns']) ?? '20') || 20
  const runIndex = Number(str(values['run-index']) ?? '1') || 1
  const gradeCmd = str(values['grade-cmd'])
  const baseRef = str(values['base-ref'])

  const variantDomain = taiyiVariantDomain(variant)
  console.log(`太一变体 ${variant} · run ${runIndex} · volatileBlock ${variantDomain.volatileBlock.length} 字 · 模型 ${provider}/${model}`)
  console.log(`workspace ${workspace} · 任务 ${tasks.map(t => t.id).join(', ')}`)
  if (values['dry-run'] === true) {
    console.log('dry-run: 不发起真实请求。变体块指纹 =', variantMarker(variant))
    return
  }
  mkdirSync(dirname(storeFile), { recursive: true })

  // 真实会话前提：项目授信（否则 AGENTS.md/.rivet.md/项目配置被静默跳过）+ 会话目录
  // （skill 快照落点）。AgentLoop 直接构造不会走 bootstrap，技能注册表需手动初始化
  // ——否则 sessionSkillSnapshot 抛「Missing skill definition」（loop.ts:789）。
  process.env.RIVET_TRUST_PROJECT = '1'
  if (!process.env.RIVET_SESSION_DIR) {
    process.env.RIVET_SESSION_DIR = join(tmpdir(), 'taiyi-pilot-sessions')
  }
  mkdirSync(process.env.RIVET_SESSION_DIR, { recursive: true })
  const { loadProjectSkills } = await import('../../src/skills/skill-loader.js')
  const skillLoad = loadProjectSkills(workspace)
  console.log(`技能初始化：loaded=${skillLoad.loaded.length} errors=${skillLoad.errors.length}`)
  for (const err of skillLoad.errors) console.log(`   skill warn: ${err}`)

  for (const task of tasks) {
    process.stdout.write(`\n[${variant}#${runIndex}] ${task.id} … `)
    const rec = await runTask(task, { variant, runIndex, provider, model, workspace, maxTurns, gradeCmd, baseRef })
    appendFileSync(storeFile, JSON.stringify(rec) + '\n')
    console.log(`${rec.status} · turns=${rec.turns} tools=${rec.toolCalls} (只读 ${rec.readOnlyToolCalls}) · in=${rec.tokensInput} out=${rec.tokensOutput} cacheR=${rec.tokensCacheRead} · ${(rec.durationMs / 1000).toFixed(1)}s`)
    console.log(`   评分: ${rec.gradeExit === undefined ? '(未配置)' : rec.gradeExit === 0 ? 'PASS (exit 0)' : `FAIL (exit ${rec.gradeExit})`}`)
    if (rec.commitsSinceBase && rec.commitsSinceBase.length > 0) {
      console.log(`   agent 自行提交 ${rec.commitsSinceBase.length} 个:\n     ${rec.commitsSinceBase.join('\n     ')}`)
    }
    console.log(`   工作区改动（未暂存）:\n${rec.diffStat || '(无 — 见上方 commits)'}`)
    if (rec.error) console.log(`   error: ${rec.error}`)
  }
  console.log(`\n结果写入 ${storeFile}`)
}

main().catch(e => { console.error('runner 失败:', e); process.exit(1) })
