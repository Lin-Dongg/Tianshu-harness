/**
 * slash 命令 → agent prompt 的解析叶子模块。
 *
 * 从 `src/tui/slash-commands.ts` 迁出（serve 启动图瘦身）：sidecar 的
 * `session-routes` 只需要 `resolveAppPromptInput`，而 slash-commands 还静态
 * import `../bootstrap.js`（switchAgentRuntime，经它进 AgentLoop）与 TUI 主图——
 * 那一跳会把 agent 内核整张图带进 listen 之前的 serve 静态闭包。这里的依赖
 * 刻意保持为叶子：ecosystem-workflows / commands-loader / skill-loader / path-like。
 *
 * `slash-commands.ts` 保留同名再导出，main.ts 与既有测试 import 面不变。
 */
import { isAbsolute, join, relative } from 'node:path'
import { resolveCustomCommand } from '../commands/loader.js'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import { skillRegistry, listSkillFiles, type SkillDefinition, type SkillRegistry, type SkillSource } from '../skills/skill-loader.js'
import { resolveEcosystemWorkflowInput } from '../workflows/ecosystem-workflows.js'
import { workspaceSkillSnapshot } from '../skills/workspace-skill-snapshot.js'
import { looksLikeFilePath } from './engine/path-like.js'

export interface ResolvedPromptInput {
  prompt: string
  skillInvoked?: string
  /** 见 WorkflowResolveResult.requiredTools。仅 ecosystem workflow 路径可能非空。 */
  requiredTools?: readonly string[]
}

export function resolveAppPromptInput(
  input: string,
  cwd: string,
  isKnownCommand?: (name: string) => boolean,
  pluginCommands?: { name: string; file: string }[],
  sessionRegistry?: SkillRegistry,
): ResolvedPromptInput | null {
  if (!input.startsWith('/')) return { prompt: input }
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return { prompt: workflow.prompt, requiredTools: workflow.requiredTools }
  const custom = resolveCustomCommand(cwd, input, pluginCommands)
  if (custom) return { prompt: custom }
  const skillPrompt = resolveSkillPrompt(input, cwd, sessionRegistry)
  if (skillPrompt !== null) return { prompt: skillPrompt, skillInvoked: skillPrompt.match(/^\[Skill loaded: ([^\]]+)\]/)?.[1] }
  // /review off|on|status 是 TUI 本地会话开关——本路径（server/headless 映射层）没有
  // refs 可写。明确告知，而不是把 "off" 误当 focus 触发一次审查（白烧 worker token）。
  if (/^\/review\s+(?:off|on|status)\s*$/i.test(input)) {
    return { prompt: `User typed "${input}". /review off|on|status is a TUI-local session toggle (auto-review gate) that this surface cannot flip. To disable auto review here, set review.skipAuto in config (desktop: Settings → Routing); manual /review [max] keeps working either way.` }
  }
  // /review [max|l1|l2|l3] [focus description] — map to deliver_task instruction for the agent
  const reviewMatch = input.match(/^\/review(?:\s+(max|l1|l2|l3))?(?:\s+(.*))?$/i)
  if (reviewMatch) {
    const kw = reviewMatch[1]?.toLowerCase()
    const focusText = reviewMatch[2]?.trim()
    const level: 'L1' | 'L2' | 'L3' = kw === 'max' || kw === 'l3' ? 'L3' : kw === 'l1' ? 'L1' : 'L2'
    const levelLabel = level === 'L3'
      ? 'L3 Review Squadron (5 inspectors)'
      : level === 'L1'
        ? 'L1 nudge (review-discipline reminder, zero review workers)'
        : 'L2 adversarial verifier'
    const focusInstruction = focusText ? ` Focus specifically on: ${focusText}.` : ''
    return { prompt: `Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="${level}". This triggers ${levelLabel}.${focusInstruction}` }
  }
  // /review typos — don't silently drop user input
  if (/^\/review/i.test(input)) {
    return { prompt: `User typed "${input}" which looks like a /review command but didn't match the expected format. Usage: /review [max] [focus description]. Run /review max to trigger L3 Review Squadron.` }
  }
  // 裸技能名直调（issue #100 建议②）：/name [task]——内置/workflow/自定义/网关
  // 均未命中后的兜底。必须放在 looksLikeFilePath 之前：单段 /name 在
  // isKnownCommand 谓词下会被判成「路径」原样透传，技能解析永远轮不到
  // （多段路径天然不匹配技能名，/etc 类单段路径无同名技能时仍落回路径分支）。
  const bareSkill = resolveBareSkillPrompt(input, cwd, sessionRegistry)
  if (bareSkill !== null) return { prompt: bareSkill, skillInvoked: bareSkill.match(/^\[Skill loaded: ([^\]]+)\]/)?.[1] }
  // Linux/WSL path like /etc, /mnt, /usr — not a recognized command, pass through
  // as plain text so the agent can handle it (e.g. "look at /etc/hosts").
  if (looksLikeFilePath(input, isKnownCommand)) return { prompt: input }
  // Unrecognized slash command — return null to signal "blocked"
  return null
}

const SKILL_RESERVED_SUBCOMMANDS = new Set(['inspect', 'add', 'mode', 'update', 'remove', 'doctor', 'generate', 'list', 'ls', 'install', 'import', 'review', 'drafts', 'approve', 'reject', 'off', 'complete'])

/**
 * 项目槽位技能来源：backing 文件随仓库分发（.rivet/skills / .agents/skills），未授信
 * 等同仓库内容指令。'project-claude' 当前不进任何 registry（仅 listInstallableSkills
 * 的扫描标记），列入是 fail-closed——未来若新增其装载路径，忘了同步此集合也不会
 * 静默放行。失效方向：宁可多门一个来源值，不漏项目槽位（漏判 = 仓库内容进用户消息）。
 */
const PROJECT_SLOT_SKILL_SOURCES: ReadonlySet<SkillSource> = new Set(['rivet', 'project-agents', 'project-claude'])

/**
 * 技能是否项目槽位（随仓库分发）。主判据是 loader 写入的 source；source 缺失时回落
 * backing 文件物理位置（早期会话快照可能没冻 source）——只判路径归属不判文件存在，
 * 全局技能（home 目录）与内置技能（无 backing 文件）永不落在 cwd 这两个子目录下，
 * 误判只可能往「不展开」侧倒，不误伤全局技能。
 */
function isProjectSlotSkill(skill: SkillDefinition, cwd: string): boolean {
  if (skill.source && PROJECT_SLOT_SKILL_SOURCES.has(skill.source)) return true
  for (const p of [skill.bodyPath, skill.skillDir]) {
    if (!p) continue
    for (const root of [join(cwd, '.rivet', 'skills'), join(cwd, '.agents', 'skills')]) {
      const rel = relative(root, p)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
    }
  }
  return false
}

/** 技能查找 + prompt 展开（/skill 网关与裸名直调共用）。未命中返回 null。 */
function buildSkillPrompt(name: string, userTask: string, cwd?: string, sessionRegistry?: SkillRegistry): string | null {
  const registry = sessionRegistry ?? (cwd ? workspaceSkillSnapshot(cwd).registry : skillRegistry)
  const skill = registry.get(name) ?? registry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  // 未授信项目按 origin 门项目槽位技能（2026-10-07 审计 Finding 1 第二入口；
  // 2026-10-08 由一刀切细化为按 origin 判门——一刀切把用户全局 ~/.rivet/skills 与
  // 内置技能也封死，属可用性误伤：它们是用户自有/随发行版内容，不受项目信任门管辖）。
  // workspaceSkillSnapshot/sessionSkillSnapshot 装载侧已排项目目录，此门兜底的窄例是
  // 「授信期冻结的 session 快照在撤信后仍含项目技能」——快照按 pinned 语义原样读回，
  // 必须在展开前判 origin。cwd 缺席时 registry 回落全局 skillRegistry（已受
  // loadProjectSkills 门保护）；生产调用点（main.ts onSubmit、session-skills-helper、
  // session-manager.createSession）均传 cwd。
  if (cwd && isProjectSlotSkill(skill, cwd) && !projectSurfaceAllowed(cwd, 'skills')) return null
  if (skill.mode === 'off') return `Skill「${skill.name}」已停用，请先启用。`
  let prompt = `[Skill loaded: ${skill.name}]\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
  if (skill.skillDir) {
    const files = skill.files ?? listSkillFiles(skill.skillDir)
    if (files.length > 0) {
      prompt += `\n<skill-files dir="${skill.skillDir}" note="Read on demand with read_file/grep/glob; page large sub-files completely with offset/limit.">\n${files.map(f => '  ' + f.path).join('\n')}\n</skill-files>`
    }
  }
  if (userTask) {
    prompt += `\n\nUser task: ${userTask}`
  }
  return prompt
}

/**
 * Resolve `/skill <name> [user task...]` into the skill's full body prompt.
 * Reserved subcommands (list/install/etc.) and unknown skills return null so
 * they fall back to the slash handler's local behavior or error message.
 */
function resolveSkillPrompt(input: string, cwd: string, sessionRegistry?: SkillRegistry): string | null {
  const match = input.trim().match(/^\/skill\s+(\S+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  if (SKILL_RESERVED_SUBCOMMANDS.has(name.toLowerCase())) return null
  return buildSkillPrompt(name, match[2]?.trim() ?? '', cwd, sessionRegistry)
}

/**
 * 裸技能名直调（issue #100 建议②，Claude Code「技能即斜杠命令」形态）：
 * `/name [task...]` 命中技能注册表则展开为 skill prompt。只在内置/workflow/
 * 自定义/网关全部未命中后兜底——同名技能被内置遮蔽但仍可经 /skill <name>
 * 显式唤起。多段路径天然不匹配（技能名不含 /）；单段路径（/etc）只有用户
 * 真建了同名技能才会被接管——那正是用户意图。
 */
export function resolveBareSkillPrompt(input: string, cwd?: string, sessionRegistry?: SkillRegistry): string | null {
  const match = input.trim().match(/^\/([^\s/]+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  if (SKILL_RESERVED_SUBCOMMANDS.has(name.toLowerCase())) return null
  return buildSkillPrompt(name, match[2]?.trim() ?? '', cwd, sessionRegistry)
}
