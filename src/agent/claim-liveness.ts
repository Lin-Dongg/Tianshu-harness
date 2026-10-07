/**
 * claim-liveness — 认领租约的活性判定（纯函数，无 IO，可表驱动测试）。
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
  /** 该文件在工作区是否干净：true 干净 / false 有未提交改动 / 'unknown' 判不了。 */
  fileClean: boolean | 'unknown'
  nowMs: number
  staleMs?: number
}

function describeAge(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 120) return `${min} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/**
 * 三级体检判定（命中即止，成本无关——纯算术）。返回 action：
 * `reap`（回收幽灵认领后重抢）/ `take`（自动接管）/ `ask`（走人工确认）。
 */
export function evaluateClaimTakeover(input: EvaluateTakeoverInput): TakeoverDecision {
  const { liveness, fileClean, nowMs, staleMs = FILE_CLAIM_STALE_MS } = input
  const owner = liveness.ownerSessionId.slice(0, 8)

  // L0 — claims 行在、sessions 行无：幽灵认领，无人在持有，回收即可。
  if (liveness.ownerPid === null) {
    return { action: 'reap', level: 'L0', reason: `认领对应的会话行已不存在（${owner}）——回收该认领` }
  }

  // L1 — 持有方进程已退出：无条件自动接管（与文件干净态无关）。
  if (!liveness.ownerAlive) {
    return { action: 'take', level: 'L1', reason: `持有方进程已退出（pid ${liveness.ownerPid}，会话 ${owner}）` }
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

  if (fileClean === true) {
    return {
      action: 'take',
      level: 'L2',
      reason: `对方（会话 ${owner}）已 ${describeAge(ageMs)} 未触碰该文件且工作区干净`,
    }
  }
  return {
    action: 'ask',
    level: 'L3',
    reason: `对方（会话 ${owner}）已 ${describeAge(ageMs)} 未触碰该文件，但工作区仍有未提交改动`,
  }
}
