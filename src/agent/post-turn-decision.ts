import type { TurnStateBag } from './turn-orchestrator.js'
import type { AgentCallbacks } from './loop-types.js'
import type { CompleteTurnParams } from './turn-orchestrator.js'
import type { SrClass } from './context.js'
import { evaluateThinkingRetry } from './thinking-retry.js'

// ── Types ──

/** The subset of TurnStateBag this controller reads/writes. Declared as a Pick
 *  so the factory can pass a partial bag (only these 3 fields) without an `as any`
 *  escape — the controller never touches the other 16 state fields. */
export type PostTurnState = Pick<TurnStateBag,
  'streamedText' | 'thinkingOnlyRetries' | 'lastThinkingContent'>

export interface PostTurnDecisionDeps {
  state: PostTurnState
  getDoomLoopLevel: () => 'none' | 'warn' | 'blocked'
  appendSystemReminder: (content: string, cls?: SrClass) => void
  /** 同 appendSystemReminder，但返回 boolean。thinking-retry 用此检测 SR cap 耗尽，
   *  避免空载荷续轮——retry 消息被吞时放弃 retry，而非盲重试。
   *  W1 通道分级：functional 类不限流 → 注入不可能失败（返回恒 true）。 */
  appendSystemReminderAndReport: (content: string, cls?: SrClass) => boolean
  completeTurn: (params: CompleteTurnParams) => Promise<void>
  getTotalUsage: () => import('../api/types.js').Usage
  getTurnCount: () => number
  /** GLM independent reasoning mode: disable thinking-only retry.
   *  GLM's deep reasoning without tools/text is a legitimate turn output,
   *  not a failed utterance — retrying only wastes time with fresh reasoning. */
  skipThinkingRetry?: boolean
  maxTurns?: number
  reserveReasoningRecovery?: () => boolean
  markReasoningRecovery?: () => void
}

export type ThinkingRetryResult =
  | { shouldRetry: true }
  | { shouldRetry: false }

// ── Controller ──

export class PostTurnDecisionController {
  constructor(private deps: PostTurnDecisionDeps) {}

  /**
   * Check if the turn produced only thinking (no text, no tools) and should be retried.
   * Returns true if a retry was triggered (caller should `continue` the loop).
   * Internally handles state writes, reminder injection, and turn archival.
   */
  async evaluateThinkingRetry(params: {
    collectedBlockCount: number
    thinkingAccum: string
    turn: number
    callbacks: AgentCallbacks
    signal: AbortSignal
  }): Promise<ThinkingRetryResult> {
    if (this.deps.skipThinkingRetry || params.signal.aborted || (this.deps.maxTurns !== undefined && params.turn + 1 >= this.deps.maxTurns)) return { shouldRetry: false }
    const result = evaluateThinkingRetry({
      streamedText: this.deps.state.streamedText,
      collectedBlockCount: params.collectedBlockCount,
      thinkingAccum: params.thinkingAccum,
      thinkingOnlyRetries: this.deps.state.thinkingOnlyRetries,
      lastThinkingContent: this.deps.state.lastThinkingContent,
    })
    this.deps.state.lastThinkingContent = result.nextState.lastThinkingContent
    this.deps.state.thinkingOnlyRetries = result.nextState.thinkingOnlyRetries
    if (result.shouldRetry) {
      if (this.deps.reserveReasoningRecovery && !this.deps.reserveReasoningRecovery()) return { shouldRetry: false }
      const injected = this.deps.appendSystemReminderAndReport(result.retryMessage, 'functional')
      if (!injected) return { shouldRetry: false }
      this.deps.markReasoningRecovery?.()
      params.callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), false)
      return { shouldRetry: true }
    }
    return { shouldRetry: false }
  }
}
