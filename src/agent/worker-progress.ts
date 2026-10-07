/**
 * worker 空转检测（2026-10-06 verifier 空转事故）。
 *
 * 事故形态：verifier 在"追查 ledger"死胡同里换着花样 grep，直到预算耗尽被中断、
 * 未产出报告。它每次换 pattern，所以单靠"同参数重复"抓不到——判据必须是
 * **这次调用有没有产出新信息**（零命中 = 无新信息），指纹重复只是其中一种形态。
 *
 * 设计取舍：**不复用 prediction-error.ts 的 EFE / getInterventionLevel**。
 * 探针实测（2026-10-06）显示两者语义相反——那边 errorRate 高 → escalate →
 * **提高** reasoning effort（加码）；这里要的是**停止探索**（收手）。方向相反，
 * 硬接会把"该收手"翻译成"加码"。EFE 对"探索/利用"的认知场路由仍然正确，只是
 * 不该承担"该收手了"这个判断。
 */

/** 与认知场 core rule 同一判据：连续 3 次无新增信息即收敛。 */
export const HARD_CONVERGE_STREAK = 3

export interface ProgressTracker {
  /** 连续多少次工具调用没产出新信息。任何一次有收获即清零。 */
  readonly noProgressStreak: number
  /** 上一次调用的 tool+参数指纹，用于识别"原样重跑"。 */
  readonly lastFingerprint: string | null
}

export function createProgressTracker(): ProgressTracker {
  return { noProgressStreak: 0, lastFingerprint: null }
}

/**
 * 记一次工具调用。
 * @param fingerprint tool+参数的稳定摘要（用于识别原样重跑）
 * @param emptyResult 这次调用是否零产出（grep 无命中 / 读到已知内容 / 空结果）
 */
export function recordToolCall(t: ProgressTracker, fingerprint: string, emptyResult: boolean): ProgressTracker {
  const repeated = t.lastFingerprint !== null && t.lastFingerprint === fingerprint
  const noProgress = emptyResult || repeated
  return {
    lastFingerprint: fingerprint,
    noProgressStreak: noProgress ? t.noProgressStreak + 1 : 0,
  }
}

/** 是否该收敛出报告了。 */
export function shouldConverge(t: ProgressTracker, threshold = HARD_CONVERGE_STREAK): boolean {
  return t.noProgressStreak >= threshold
}

/** 收敛 steer 文案（与认知场 core rule 同口径，附"已证无即结论"的处置）。 */
export function convergenceSteer(): string {
  return '[收敛警告] 连续多次工具调用没有新增信息。停止探索——用你已经捕获的证据出报告。'
    + '「已证无」是结论：列出试过的 pattern 与结果，直接给 WorkerResult；不要再发明新的搜索。'
}

/**
 * 选本次该注入的 steer：空转收敛优先，发一次即止；否则回落外部通道
 * （soft-landing 的 wrap-up / coordinator 的 per-order steer 队列）。
 *
 * 抽成纯函数是为了让「空转 → 收敛 steer」这条接线本身可单测——runOnce 里的
 * 回调装配不方便直接测，但它做的决策在这里被钉死。
 */
export function pickSteer(
  t: ProgressTracker,
  convergenceSent: boolean,
  external: () => string | null,
): { steer: string | null; convergenceSent: boolean } {
  if (shouldConverge(t) && !convergenceSent) {
    return { steer: convergenceSteer(), convergenceSent: true }
  }
  return { steer: external(), convergenceSent }
}
