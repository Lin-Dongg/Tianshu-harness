/**
 * claim-liveness — 认领租约的活性判定（判定逻辑为纯函数，可表驱动测试；
 * 工作区脏态探针是注入的惰性 IO——见 EvaluateTakeoverInput.probeFileClean）。
 *
 * v2（认领即租约）：v1 设计（docs/design/2026-10-07-claim-lease-liveness.md）
 * 用**会话心跳**判「沉睡」，但心跳由 bootstrap 的 10s `setInterval` 无条件刷新
 * （src/bootstrap.ts:1332）——活会话闲置时心跳恒新鲜，L2 永不命中，动机案例
 * （活会话早已走人却仍独占文件）只能退到「问」。本模块改用**文件级租约凭据**
 * `claims.last_touched_at`（由 `acquireClaim` 同会话分支刷新，覆盖全部写路径）。
 *
 * 失效方向一律向「不接管」偏：只有 L1（持有方已死）与 L2（陈旧 ∧ 工作区干净）
 * 自动接管；其余（新鲜 / 陈旧但脏 / 证据不可解析 / shared_read 持有者）→ 问。
 *
 * @module claim-liveness
 */
import type { ClaimLiveness } from './session-registry.js'

/**
 * 认领冲突审批载荷——tool-pipeline 在显式接管（action 'ask' 落人工确认）时塞进
 * `onApprovalRequired` input 的 `__claimConflict` 键。消费方（TUI 审批卡 /
 * sidecar approval_required 事件）一律经 readClaimConflict 防御性读取：审批
 * input 可被用户编辑（TUI e 键）或被网关透传改动，字段缺失必须降级为普通审批
 * 措辞，而不是把半结构化垃圾渲染给用户。
 */
export interface ClaimConflictInfo {
  filePath: string
  ownerSessionId: string
  /** 判定时持有方进程是否存活（L1 已死会被自动接管，走到这里的多为存活/不可判定）。 */
  ownerAlive?: boolean
  /** 持有方最后触碰该文件的时刻（ISO 字符串，claims.last_touched_at）。 */
  lastTouchedAt?: string
  /** evaluateClaimTakeover 的人读判据（L3/L4 ask 分支），内含「是否陈旧」。 */
  reason?: string
}

/** 从审批 input 读出认领冲突信息；形状不符（含被编辑过）返回 null。 */
export function readClaimConflict(input: Record<string, unknown>): ClaimConflictInfo | null {
  const raw = input.__claimConflict
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.filePath !== 'string' || typeof value.ownerSessionId !== 'string') return null
  return {
    filePath: value.filePath,
    ownerSessionId: value.ownerSessionId,
    ...(typeof value.ownerAlive === 'boolean' ? { ownerAlive: value.ownerAlive } : {}),
    ...(typeof value.lastTouchedAt === 'string' ? { lastTouchedAt: value.lastTouchedAt } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  }
}

/**
 * 文件级租约的陈旧阈值。`bash` 默认超时 120s，单次工具操作极少超分钟级；
 * 10 分钟 ≈ 5× 默认预算，留足「写 → 读 → 再写」的间隔。可调，但先不做矩阵。
 */
export const FILE_CLAIM_STALE_MS = 10 * 60_000

export type TakeoverAction = 'take' | 'ask' | 'reap'
export type TakeoverLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

export interface TakeoverDecision {
  action: TakeoverAction
  level: TakeoverLevel
  /** 人可读判据，供 tool_result 告知与日志点名（静默接管是禁止的）。 */
  reason: string
}

export interface EvaluateTakeoverInput {
  liveness: ClaimLiveness
  /**
   * 工作区脏态探针（惰性，注入的 IO）：返回值 true 干净 / false 有未提交改动 /
   * 'unknown' 判不了。**只有真正需要脏态的分支才会调用**——L1 注记（设计 §6 要求
   * 点名「对方工作区里还留着什么」）与 L2/L3 判定；L0（幽灵回收）与 L4（新鲜 /
   * shared_read / 时间不可解析）分支永不触发。探针背后是 spawn `git status`
   * （挂起时最坏 10s+3s），不需要它的分支不该付这笔账（2026-10-08 审查）。
   */
  probeFileClean: () => Promise<boolean | 'unknown'>
  nowMs: number
  staleMs?: number
}

function describeAge(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 120) return `${min} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/**
 * 三级体检判定（命中即止）。返回 action：
 * `reap`（回收幽灵认领后重抢）/ `take`（自动接管）/ `ask`（走人工确认）。
 * async 仅因脏态探针是惰性 await——无探针分支（L0/L4）不触发任何 IO。
 */
export async function evaluateClaimTakeover(input: EvaluateTakeoverInput): Promise<TakeoverDecision> {
  const { liveness, probeFileClean, nowMs, staleMs = FILE_CLAIM_STALE_MS } = input
  const owner = liveness.ownerSessionId.slice(0, 8)

  // L0 — claims 行在、sessions 行无：幽灵认领，无人在持有，回收即可（无需脏态）。
  if (liveness.ownerPid === null) {
    return { action: 'reap', level: 'L0', reason: `认领对应的会话行已不存在（${owner}）——回收该认领` }
  }

  // L1 — 持有方进程已退出：无条件自动接管（判定与文件干净态无关）。死持有方
  // 不可能再刷新租约凭据（TOCTOU 不适用），此处探测是安全的；设计 §6 要求接管
  // 注记点名「对方工作区里还留着什么」，脏态附进 reason。
  if (!liveness.ownerAlive) {
    const clean = await probeFileClean()
    const leftBehind = clean === true
      ? '；其工作区中该文件无未提交改动'
      : clean === false
        ? '；其工作区中该文件仍留有未提交改动（本接管不触碰这些改动）'
        : '；其工作区脏态不可判定'
    return { action: 'take', level: 'L1', reason: `持有方进程已退出（pid ${liveness.ownerPid}，会话 ${owner}）${leftBehind}` }
  }

  // shared_read 持有者不经写路径刷新 last_touched_at——凭据对它无意义，一律问。
  if (liveness.claimType !== 'exclusive') {
    return { action: 'ask', level: 'L4', reason: `对方（会话 ${owner}）持有 shared_read 认领，保留人工确认` }
  }

  const touchedMs = Date.parse(liveness.lastTouchedAt)
  const ageMs = nowMs - touchedMs
  // 不可解析（NaN）与「新鲜」同归 L4：缺证据不得当陈旧。
  if (!(ageMs >= staleMs)) {
    const ageText = Number.isFinite(ageMs) ? `${describeAge(ageMs)}` : '（时间不可解析）'
    return { action: 'ask', level: 'L4', reason: `对方（会话 ${owner}）${ageText}前刚触碰该文件，按真并发处理` }
  }

  // L2/L3 判定需要脏态——只有走到这里才触发探针。
  const clean = await probeFileClean()
  if (clean === true) {
    return {
      action: 'take',
      level: 'L2',
      reason: `对方（会话 ${owner}）已 ${describeAge(ageMs)} 未触碰该文件且工作区干净`,
    }
  }
  return {
    action: 'ask',
    level: 'L3',
    // 'unknown'（含全仓认领键跳过探测）不得谎称「仍有未提交改动」——审批卡按
    // reason 渲染，缺证据要如实说缺证据。
    reason: clean === false
      ? `对方（会话 ${owner}）已 ${describeAge(ageMs)} 未触碰该文件，但工作区仍有未提交改动`
      : `对方（会话 ${owner}）已 ${describeAge(ageMs)} 未触碰该文件，且工作区脏态不可判定（缺证据不落自动接管）`,
  }
}
