import { QUALITY_ORDER, QUALITY_CODE } from './cognitive-quality.js'
/**
 * P3 Wave 3：认知帧回放遥测——记录构造 + 确定性回放对账。
 *
 * 记录两档（telemetry-writer 按 full/lite 自动过滤）：
 * - `cognitive-frame`（仅 RIVET_DEBUG_TELEMETRY full 模式落盘）：facts 全量 +
 *   structure-flow 输出摘要 + convergence 摘要，可被 replay 完整重算。
 * - `cognitive-frame-lite`（默认落盘）：单行 <200B 摘要，事后能回答
 *   「该 turn 松弛了多少、哪些 source 缺数据、有没有 abort」。
 *
 * 回放纪律（与设计钉死）：
 * - 纯函数，无 IO、无时钟；同 records 两次调用输出深相等。
 * - 只重算 structure-flow（输入全在 facts 内、完全确定）；convergence 摘要
 *   仅作记录对账，不重算（其输入面远大于 frame 承载——审查修正 ①）。
 * - fingerprint 重算失配 = facts 被篡改/序列化漂移，优先级最高。
 * - 硬线不变量机检：硬收紧事实（needs_user / stalled / 用户干预 / 验证债务）
 *   为真时 relaxation 必须为 0；relaxation ∉ [0, 0.25] 一律违规。
 * - 关键 source 质量不足的 turn 报 degraded，不冒充 healthy。
 */

import {
  assembleCognitiveFrame,
  fingerprintCognitiveFrame,
  projectStructureFlowInputs,
  type CognitiveFactQuality,
  type CognitiveFactSource,
  type CognitiveFrame,
  type CognitiveFrameFacts,
} from './cognitive-frame.js'
import { computeStructureFlowControl, type StructureFlowSnapshot } from './structure-flow-controller.js'
import type { ConvergenceResult } from './convergence-detector.js'

export const COGNITIVE_FRAME_KIND = 'cognitive-frame'
export const COGNITIVE_FRAME_LITE_KIND = 'cognitive-frame-lite'

// type 别名（非 interface）：带隐式索引签名，可直接赋给 telemetry-writer 的
// `{ kind: string } & Record<string, unknown>` 通道。
export type CognitiveFrameRecord = {
  kind: typeof COGNITIVE_FRAME_KIND
  v: 1 | 2
  turn: number
  phaseClass: string
  inputFingerprint: string
  quality: Record<CognitiveFactSource, CognitiveFactQuality>
  facts: CognitiveFrameFacts
  structureFlow: Pick<StructureFlowSnapshot,
    'mode' | 'relaxation' | 'planRecommendation' | 'tddRecommendation' | 'reasons'> | null
  convergence: {
    level: number
    shouldAbort: boolean
    abortCause: 'no-tool' | 'score' | null
    /** 方向凭证（Layer 2）：注入消息的结构化变体——发射门据它判"是否改道"。
     *  可选：2026-10-05 之前的记录没有此字段（frames.jsonl 是跨版本资产）。 */
    variant?: string | null
    /** 该 turn 的发射决策：emitted + 被哪道门拦下（wall-clock / cooldown /
     *  user-intervention …）。让「这几次被什么放行」只从落盘数据可答。
     *  可选：同上，旧记录无此字段。 */
    gate?: { emitted: boolean; suppressedBy: string | null } | null
  } | null
}

export function buildCognitiveFrameRecord(
  frame: CognitiveFrame,
  structureFlow: StructureFlowSnapshot | null,
  convergence: Pick<ConvergenceResult, 'level' | 'shouldAbort' | 'abortCause' | 'messageVariant'> | null,
  gate: { emitted: boolean; suppressedBy: string | null } | null = null,
): CognitiveFrameRecord {
  return {
    kind: COGNITIVE_FRAME_KIND,
    v: frame.v,
    turn: frame.turn,
    phaseClass: frame.phaseClass,
    inputFingerprint: frame.inputFingerprint,
    quality: { ...frame.quality },
    facts: frame.facts,
    structureFlow: structureFlow
      ? {
        mode: structureFlow.mode,
        relaxation: structureFlow.relaxation,
        planRecommendation: structureFlow.planRecommendation,
        tddRecommendation: structureFlow.tddRecommendation,
        reasons: [...structureFlow.reasons],
      }
      : null,
    convergence: convergence
      ? {
        level: convergence.level,
        shouldAbort: convergence.shouldAbort,
        abortCause: convergence.abortCause ?? null,
        variant: convergence.messageVariant ?? null,
        gate,
      }
      : null,
  }
}

/** quality 压缩码：按固定 source 顺序，m=measured p=partial x=missing v=vacuous。 */
export type CognitiveFrameLiteRecord = {
  kind: typeof COGNITIVE_FRAME_LITE_KIND
  v: 1 | 2
  turn: number
  /** fingerprint 前 12 位——与 full 记录/control-plane 遥测做关联对账。 */
  fp: string
  mode: StructureFlowSnapshot['mode'] | null
  relax: number | null
  lvl: number | null
  abort: 'no-tool' | 'score' | null
  /** 8 字符 quality 压缩码，QUALITY_ORDER 顺序。 */
  q: string
}

export function buildCognitiveFrameLiteRecord(
  frame: CognitiveFrame,
  structureFlow: StructureFlowSnapshot | null,
  convergence: Pick<ConvergenceResult, 'level' | 'shouldAbort' | 'abortCause'> | null,
): CognitiveFrameLiteRecord {
  return {
    kind: COGNITIVE_FRAME_LITE_KIND,
    v: frame.v,
    turn: frame.turn,
    fp: frame.inputFingerprint.slice(0, 12),
    mode: structureFlow?.mode ?? null,
    relax: structureFlow?.relaxation ?? null,
    lvl: convergence?.level ?? null,
    abort: convergence?.abortCause ?? null,
    q: QUALITY_ORDER.map(s => QUALITY_CODE[frame.quality[s]]).join(''),
  }
}

// ─── 确定性回放 ─────────────────────────────────────────────────────

export interface ReplayDivergence {
  turn: number
  field: string
  recorded: unknown
  recomputed: unknown
}

export interface ReplayViolation {
  turn: number
  rule: string
  detail: string
}

export interface ReplayReport {
  checkedCount: number
  divergences: ReplayDivergence[]
  violations: ReplayViolation[]
  /** 关键 source（efe/sensorium）质量非 measured 的 turn——degraded，非 healthy。 */
  degradedTurns: number[]
}

/** relaxation 数值比较容差——记录经 JSON 往返，双精度逐位可保，但防御性给 1e-9。 */
const EPS = 1e-9

export function replayCognitiveFrames(records: readonly CognitiveFrameRecord[]): ReplayReport {
  const divergences: ReplayDivergence[] = []
  const violations: ReplayViolation[] = []
  const degradedTurns: number[] = []

  for (const record of records) {
    if (record.v !== 1 && record.v !== 2) {
      divergences.push({ turn: record.turn, field: 'v', recorded: record.v, recomputed: 2 })
      continue
    }

    // ① fingerprint 对账：facts 未被篡改、序列化未漂移。
    const recomputedFp = fingerprintCognitiveFrame(record)
    if (recomputedFp !== record.inputFingerprint) {
      divergences.push({
        turn: record.turn, field: 'inputFingerprint',
        recorded: record.inputFingerprint, recomputed: recomputedFp,
      })
    }

    // ② 从 facts 重装配 → quality 对账（质量规则漂移可见）。
    const frame = assembleCognitiveFrame({
      turn: record.turn,
      phaseClass: record.phaseClass,
      ...record.facts,
    }, record.v)
    for (const source of QUALITY_ORDER) {
      if (frame.quality[source] !== record.quality[source]) {
        divergences.push({
          turn: record.turn, field: `quality.${source}`,
          recorded: record.quality[source], recomputed: frame.quality[source],
        })
      }
    }
    if (frame.quality.efe !== 'measured' || frame.quality.sensorium !== 'measured') {
      degradedTurns.push(record.turn)
    }

    // ③ structure-flow 重算：投影 → P2 纯函数 → 与记录输出逐字段比对。
    const inputs = projectStructureFlowInputs(frame)
    const recomputed = inputs ? computeStructureFlowControl(inputs) : null
    if ((recomputed === null) !== (record.structureFlow === null)) {
      divergences.push({
        turn: record.turn, field: 'structureFlow',
        recorded: record.structureFlow === null ? null : 'snapshot',
        recomputed: recomputed === null ? null : 'snapshot',
      })
    } else if (recomputed && record.structureFlow) {
      const rec = record.structureFlow
      if (recomputed.mode !== rec.mode) {
        divergences.push({ turn: record.turn, field: 'structureFlow.mode', recorded: rec.mode, recomputed: recomputed.mode })
      }
      if (Math.abs(recomputed.relaxation - rec.relaxation) > EPS) {
        divergences.push({ turn: record.turn, field: 'structureFlow.relaxation', recorded: rec.relaxation, recomputed: recomputed.relaxation })
      }
      if (recomputed.planRecommendation !== rec.planRecommendation) {
        divergences.push({ turn: record.turn, field: 'structureFlow.planRecommendation', recorded: rec.planRecommendation, recomputed: recomputed.planRecommendation })
      }
      if (recomputed.tddRecommendation !== rec.tddRecommendation) {
        divergences.push({ turn: record.turn, field: 'structureFlow.tddRecommendation', recorded: rec.tddRecommendation, recomputed: recomputed.tddRecommendation })
      }
      if (recomputed.reasons.join('|') !== rec.reasons.join('|')) {
        divergences.push({ turn: record.turn, field: 'structureFlow.reasons', recorded: rec.reasons.join('|'), recomputed: recomputed.reasons.join('|') })
      }
    }

    // ④ 硬线不变量机检（对记录值——回放要抓的是"当时真的越线了"）。
    const sf = record.structureFlow
    if (sf) {
      if (!(sf.relaxation >= 0 && sf.relaxation <= 0.25)) {
        violations.push({
          turn: record.turn, rule: 'relaxation-range',
          detail: `relaxation=${sf.relaxation} ∉ [0, 0.25]`,
        })
      }
      if (sf.relaxation > 0) {
        const hardFacts: Array<[string, boolean]> = [
          ['pal.anyNeedsUser', record.facts.pal?.anyNeedsUser ?? false],
          ['pal.anyStalled', record.facts.pal?.anyStalled ?? false],
          ['user.intervened', record.facts.user.intervened],
          ['evidence.hasVerificationDebt', record.facts.evidence.hasVerificationDebt],
          ['evidence.consecutiveFailures>=2', record.facts.evidence.consecutiveFailures >= 2],
        ]
        for (const [name, active] of hardFacts) {
          if (active) {
            violations.push({
              turn: record.turn, rule: 'hard-tighten-bypassed',
              detail: `${name}=true 而 relaxation=${sf.relaxation} > 0`,
            })
          }
        }
      }
    }
  }

  return { checkedCount: records.length, divergences, violations, degradedTurns }
}
