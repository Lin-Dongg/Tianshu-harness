/**
 * 收敛发射门 —— 判定与副作用分离的纯计算（后续 A 遥测，2026-10-05）。
 *
 * 为什么单独成模块：frames.jsonl 的落盘点位于发射**副作用之前**，要让
 * 「这几次是被什么放行的」只从落盘数据可答，判定必须先算出来；判定与副作用
 * 写在同一块里就拿不到。抽成纯函数后 loop 只留装配，且可独立单测——
 * 无 this、无时钟（nowMs 由调用方传入，同输入同输出）。
 */

export interface ConvergenceEmitState {
  lastEmitTurn: number
  lastEmitLevel: number
  lastMsgKey: string
  lastEmitScore: number
  lastEmitVerifyFailStreak: number
  lastEmitAtMs: number
  cooldownTurns: number
  minIntervalMs: number
}

export interface ConvergenceEmitPlan {
  emit: boolean
  /** emit=false 时的原因；emit=true 时为 null。 */
  suppressedBy: string | null
  msgKey: string
  changedDirection: boolean
  escalated: boolean
  verifyFailStreak: number
}

export interface ConvergenceEmitInput {
  shouldKick: boolean
  injectedMessage: string | null
  messageVariant: string | null
  level: number
  score: number
  turn: number
  userMessageConsumed: boolean
  verifyFailStreak: number
  nowMs: number
  state: ConvergenceEmitState
}

/** 返回 null = 本轮无告警可发（未达 kick 或无注入消息）。 */
export function planConvergenceEmit(input: ConvergenceEmitInput): ConvergenceEmitPlan | null {
  if (!input.shouldKick || !input.injectedMessage) return null
  if (input.userMessageConsumed) {
    // 用户刚开口 = agent 已把控制权交回（收敛的正确结局），不补刀。
    return {
      emit: false,
      suppressedBy: 'user-intervention',
      msgKey: '',
      changedDirection: false,
      escalated: false,
      verifyFailStreak: 0,
    }
  }
  const { state } = input
  // 方向凭证取结构化变体标识（messageVariant），而非文案首行——文案是给人读的，
  // 会随措辞迭代而变；用它当凭证等于每次改词都重置冷却并立即重发。
  const msgKey = input.messageVariant ?? ''
  const cooldownElapsed = input.turn - state.lastEmitTurn >= state.cooldownTurns
  const scoreDropped = state.lastEmitScore - input.score > 0.15
  const cooledDown = cooldownElapsed || scoreDropped
  const escalated = input.level > state.lastEmitLevel
  const changedDirection = msgKey !== state.lastMsgKey
  // 第四突破条件（2026-07-04 触发面修复）：验证失败流水加深 = 排查轮次正在膨胀，
  // 不等冷却到期提前发射。
  const verifyFailEscalated = input.verifyFailStreak >= 2
    && input.verifyFailStreak > state.lastEmitVerifyFailStreak
  // 墙钟下限只约束非升级发射（只读诊断轮墙钟极短，"3 轮冷却"只有几秒）；
  // 升级是真实信号跃迁，必须穿透。
  const wallClockElapsed = input.nowMs - state.lastEmitAtMs >= state.minIntervalMs
  const emit = escalated || (wallClockElapsed && (cooledDown || changedDirection || verifyFailEscalated))
  const suppressedBy = emit ? null : !wallClockElapsed ? 'wall-clock' : 'cooldown'
  return { emit, suppressedBy, msgKey, changedDirection, escalated, verifyFailStreak: input.verifyFailStreak }
}
