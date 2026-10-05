import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { didYouMeanHint } from './did-you-mean.js'

/**
 * Foreign tool names from other agent frameworks (Cursor, Claude Code, etc.)
 * mapped to their Rivet equivalents. Transparent remapping avoids forcing
 * the model to memorize framework-specific tool names — the call just works.
 *
 * Key: foreign name (case-insensitive lookup).
 * Val: Rivet tool name.
 */
const FOREIGN_ALIASES: Record<string, string> = {
  todowrite: 'todo',
  task: 'delegate_task',
  agent: 'delegate_task',
}

// ── 同名覆盖检测（rug pull 防线 ④）────────────────────────────────────────
// 背景：register 为 Map.set 后到者赢，被覆盖方无任何信号（安全报告《MCP 工具
// 描述 rug pull》§2.3 —— 攻击者可注册同名工具静默替换）。已知的预期重注册
// 来源（按前缀静默，不告警）：
//   - mcp__：MCP 重连/重拉/热更新对同一 serverId 的工具面重建（manager 侧有意
//     静默替换）。跨 server 的 sanitize 撞名（'a_b' vs 'a__b'）在名字层面与
//     同源重拉不可区分，属已知残余；根治在命名层（mcpToolName 的有损映射）。
//   - lsp_：serve-agent.attachLspTools 每次 assembleAgentLoop 重挂（switchModel
//     安全性的设计约束，"重复 register 无害"，serve-agent.ts:180）。
// 其余同名覆盖此前静默——本检测把"后到者赢"变为至少可观察：默认通道
// console.error 一条（进程级一次/名字），**不改变覆盖行为本身**。
const KNOWN_REFRESH_PREFIXES = ['mcp__', 'lsp_'] as const

/** 已知刷新（预期幂等重注册）或意外覆盖。 */
export function classifyToolOverwrite(name: string): 'known-refresh' | 'unexpected' {
  return KNOWN_REFRESH_PREFIXES.some((p) => name.startsWith(p)) ? 'known-refresh' : 'unexpected'
}

/** 默认告警输出口（测试经 __setOverwriteSink 替换）。 */
let overwriteSink: ((msg: string) => void) | null = null

/** @internal 测试缝：替换默认告警 sink；null 恢复 console.error。 */
export function __setOverwriteSink(sink: ((msg: string) => void) | null): void {
  overwriteSink = sink
}

const reportedOverwrites = new Set<string>()

/** @internal 测试缝：重置进程级去重台账。 */
export function __resetOverwriteLog(): void {
  reportedOverwrites.clear()
}

function reportOverwriteOnce(name: string): void {
  if (reportedOverwrites.has(name)) return
  reportedOverwrites.add(name)
  const line = `[rivet] 工具注册覆盖：「${name}」被新实例替换（非 mcp__/lsp_ 的预期刷新）。`
    + '若这不是插件热重载等已知路径，请检查同名注册来源——注册表为 Map.set 后到者赢。'
  if (overwriteSink) overwriteSink(line)
  else console.error(line)
}

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  /** 同名覆盖上报口（见文件头「同名覆盖检测」）。注入 = 每次意外覆盖都回调；
   *  缺省 = reportOverwriteOnce（进程级一次/名字 + console.error）。 */
  private readonly onToolOverwrite?: (name: string) => void
  /** 异步晚到注册（MCP/插件/LSP）未完成计数 + 等待者。见 awaitExtraRegistrations。 */
  private extraRegistrationPending = 0
  private extraRegistrationWaiters: Array<() => void> = []

  constructor(opts: { onToolOverwrite?: (name: string) => void } = {}) {
    this.onToolOverwrite = opts.onToolOverwrite
  }

  register(tool: Tool): void {
    const existing = this.tools.get(tool.definition.name)
    if (existing && existing !== tool && classifyToolOverwrite(tool.definition.name) === 'unexpected') {
      (this.onToolOverwrite ?? reportOverwriteOnce)(tool.definition.name)
    }
    this.tools.set(tool.definition.name, tool)
  }

  /**
   * 异步晚到注册就绪闸门（2026-09-06 缓存碎裂根修，回流自 3.14alpha 71872ed9f）。
   *
   * bootstrap 默认走 asyncExtras 快启动路径：MCP/插件/LSP 的注册 fire-and-forget，
   * 完成时各自调一次 updateTools。若首个 LLM 请求抢在这些注册完成之前发出，晚到的
   * tools 变化会把已缓存前缀在 tools 位置打断（会话 51f279bd t1 42k 整段重建实证，
   * v3.12/3.13 用户「缓存一直碎」反馈的主源之一）。
   *
   * 用法：bootstrap 每个异步注册期 beginExtraRegistration()，完成后
   * endExtraRegistration()；AgentLoop.run() 入口 awaitExtraRegistrations()——
   * pending 清零（常态，后续 run 零开销）或超时放行。等待发生在 user 消息边界，
   * 断尾本就在此发生，工具变化吸收进边界 = 零缓存成本。
   */
  beginExtraRegistration(): void {
    this.extraRegistrationPending += 1
  }

  endExtraRegistration(): void {
    this.extraRegistrationPending = Math.max(0, this.extraRegistrationPending - 1)
    if (this.extraRegistrationPending === 0) {
      const waiters = this.extraRegistrationWaiters
      this.extraRegistrationWaiters = []
      for (const w of waiters) w()
    }
  }

  /** 等待全部异步注册清零；超时放行（防挂死的 MCP 阻塞会话）。已清零时立即返回。 */
  async awaitExtraRegistrations(timeoutMs: number): Promise<void> {
    if (this.extraRegistrationPending <= 0) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.extraRegistrationWaiters.push(finish)
    })
  }

  /** Remove a tool by name. No-op if not registered. Returns true if removed. */
  remove(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** Names of every registered tool, sorted for stable did-you-mean hints. */
  getAllNames(): string[] {
    return Array.from(this.tools.keys()).sort()
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter(t => t.isEnabled())
      .map(t => t.definition)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Resolve a possibly-foreign tool name to its canonical registered name.
   * Returns the input unchanged when it is already registered or no alias
   * matches. The tool pipeline calls this BEFORE its permission gates
   * (plan-mode, deny rules, approval, risk) so aliases cannot slip past
   * policies keyed on the canonical name.
   */
  resolveName(name: string): string {
    if (this.tools.has(name)) return name
    const aliasKey = FOREIGN_ALIASES[name.toLowerCase()]
    if (aliasKey && this.tools.has(aliasKey)) return aliasKey
    return name
  }

  async execute(name: string, params: ToolCallParams): Promise<ToolResult> {
    let tool = this.tools.get(name)
    let resolvedName = name
    let aliasNote: string | undefined

    // Fallback alias remapping for direct callers that bypass the tool
    // pipeline (which already canonicalizes via resolveName before its gates).
    if (!tool) {
      const aliasKey = FOREIGN_ALIASES[name.toLowerCase()]
      if (aliasKey) {
        tool = this.tools.get(aliasKey)
        if (tool) {
          resolvedName = aliasKey
          aliasNote = `[NOTE: "${name}" 自动映射为 "${aliasKey}" — 下次请直接调 ${aliasKey}]`
        }
      }
    }

    if (!tool) {
      // Session 6176a17f history: LLM hallucinated `task` (Cursor/Claude Code
      // convention) instead of `delegate_task`. The bare "Unknown tool: task"
      // message was unhelpful — the next model turn had to guess the real
      // name from memory. Surfacing a did-you-mean hint + the full tool
      // catalog turns the failure into a learnable signal.
      const hint = didYouMeanHint(name, this.getAllNames())
      // EXTENDED-layer guidance comes first so the did-you-mean hint — whose
      // trailing "Available tools: a, b, c" is the model's positive anchor (and
      // the prefix-cache-stable sorted catalog) — stays the final section. The
      // previous order glued "…cIf this is an EXTENDED…" together, polluting both
      // readability and the catalog parse.
      throw new Error(`Unknown tool: ${name}. If this is an EXTENDED-layer tool, use delegate_task to dispatch a worker, or /tools enable <name> to mount it on the primary agent. ${hint}`)
    }
    if (!tool.isEnabled()) throw new Error(`Tool ${resolvedName} is disabled`)

    const result = await tool.execute(params)
    if (aliasNote) {
      result.content = `${aliasNote}\n${result.content}`
    }
    return result
  }

  needsApproval(name: string, params: ToolCallParams): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    return tool.requiresApproval(params)
  }
}

export function filterToolRegistry(source: ToolRegistry, allowedNames: readonly string[]): ToolRegistry {
  const filtered = new ToolRegistry()
  for (const name of allowedNames) {
    const tool = source.get(name)
    if (!tool) throw new Error(`Cannot allowlist unknown tool: ${name}`)
    filtered.register(tool)
  }
  return filtered
}
