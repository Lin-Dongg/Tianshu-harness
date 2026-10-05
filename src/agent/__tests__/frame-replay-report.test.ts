import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFrameRecord,
  buildAdmissionReport,
  parseFrameLines,
  FRAME_CLASS_KEYS,
  type SessionFrames,
} from '../frame-replay-report.js'
import { assembleCognitiveFrame, projectStructureFlowInputs, type CognitiveFrameInput } from '../cognitive-frame.js'
import { computeStructureFlowControl } from '../structure-flow-controller.js'
import { buildCognitiveFrameRecord, type CognitiveFrameRecord } from '../cognitive-frame-replay.js'

function frameInput(overrides: Partial<CognitiveFrameInput> = {}): CognitiveFrameInput {
  return {
    turn: 8,
    phaseClass: 'explore',
    efe: { epistemicValue: 0.15, pragmaticValue: 0.9, noveltyBonus: 0.2, precision: 0.9 },
    sensorium: { momentum: 1, momentumHasData: true, stability: 1 },
    flow: { score: 0.9, sampleCount: 4, requiredSamples: 4 },
    pal: { activeCases: 0, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: false },
    evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 0 },
    user: { intervened: false },
    plan: { activePlanFile: false, planModeState: 'off' },
    progress: { todoCompletedDelta: 2 },
    ...overrides,
  }
}

/** 自洽记录：装配 → 投影 → 控制器 → 记录（经 JSON 往返模拟落盘）。 */
function consistentRecord(
  overrides: Partial<CognitiveFrameInput> = {},
  convergence: { level: 0 | 1 | 2 | 3; shouldAbort: boolean; abortCause?: 'no-tool' | 'score' } =
    { level: 0, shouldAbort: false },
): CognitiveFrameRecord {
  const frame = assembleCognitiveFrame(frameInput(overrides))
  const inputs = projectStructureFlowInputs(frame)
  const sf = inputs ? computeStructureFlowControl(inputs) : null
  return JSON.parse(JSON.stringify(buildCognitiveFrameRecord(frame, sf, { ...convergence, messageVariant: null }))) as CognitiveFrameRecord
}

describe('classifyFrameRecord — 六类反例映射（非互斥）', () => {
  it('健康 flow：mode=flow 判定（稳定执行输入）', () => {
    const classes = classifyFrameRecord(consistentRecord())
    assert.ok(classes.has('healthyFlow'))
    assert.ok(!classes.has('unknownDomain'))
  })

  it('未知域：structureFlow.reasons ∋ unknown-domain（EFE epistemic 高），非 quality missing', () => {
    // epistemic 高 → 控制器产出 unknown-domain reason。
    const record = consistentRecord({
      efe: { epistemicValue: 0.9, pragmaticValue: 0.2, noveltyBonus: 0.8, precision: 0.4 },
    })
    assert.ok(record.structureFlow!.reasons.includes('unknown-domain'), '前置：控制器确实产出 unknown-domain')
    assert.ok(classifyFrameRecord(record).has('unknownDomain'))

    // 对照：EFE 缺失（quality missing）≠ 未知域——structureFlow 为 null。
    const missing = consistentRecord({ efe: null })
    assert.equal(missing.structureFlow, null)
    assert.ok(!classifyFrameRecord(missing).has('unknownDomain'))
  })

  it('PAL needs_user / stalled 分别命中 palAttention', () => {
    const needsUser = consistentRecord({ pal: { activeCases: 1, anyNeedsUser: true, anyStalled: false, hasPlannedProbes: false } })
    const stalled = consistentRecord({ pal: { activeCases: 1, anyNeedsUser: false, anyStalled: true, hasPlannedProbes: false } })
    assert.ok(classifyFrameRecord(needsUser).has('palAttention'))
    assert.ok(classifyFrameRecord(stalled).has('palAttention'))
    assert.ok(!classifyFrameRecord(consistentRecord()).has('palAttention'))
  })

  it('verification debt / user intervention / no-tool 各自命中', () => {
    const debt = consistentRecord({ evidence: { hasVerificationDebt: true, deliveryStatus: 'failed', consecutiveFailures: 0 } })
    assert.ok(classifyFrameRecord(debt).has('verificationDebt'))

    const intervened = consistentRecord({ user: { intervened: true } })
    assert.ok(classifyFrameRecord(intervened).has('userIntervention'))

    const noTool = consistentRecord({}, { level: 3, shouldAbort: true, abortCause: 'no-tool' })
    assert.ok(classifyFrameRecord(noTool).has('noTool'))
    const scoreAbort = consistentRecord({}, { level: 3, shouldAbort: true, abortCause: 'score' })
    assert.ok(!classifyFrameRecord(scoreAbort).has('noTool'), 'score abort 不算 no-tool 反例')
  })

  it('非互斥：一条记录可同时命中多类', () => {
    // 健康 flow 输入 + no-tool abort（P2 硬线：flow 不豁免 no-tool）。
    const record = consistentRecord({}, { level: 3, shouldAbort: true, abortCause: 'no-tool' })
    const classes = classifyFrameRecord(record)
    assert.ok(classes.has('healthyFlow'))
    assert.ok(classes.has('noTool'))
  })
})

describe('buildAdmissionReport — 准入聚合', () => {
  function session(id: string, records: CognitiveFrameRecord[], parseWarnings = 0): SessionFrames {
    return { sessionId: id, records, parseWarnings }
  }

  it('全部条件满足 → admitted=true，missing 为空', () => {
    // 构造 15 个 session、每个 20 条记录，六类反例各有覆盖。
    const sessions: SessionFrames[] = []
    for (let s = 0; s < 15; s++) {
      const records: CognitiveFrameRecord[] = []
      for (let t = 0; t < 20; t++) records.push(consistentRecord({ turn: t + 1 }))
      // 前 6 个 session 各注入一类反例记录。
      if (s === 0) records.push(consistentRecord({ turn: 99, efe: { epistemicValue: 0.9, pragmaticValue: 0.2, noveltyBonus: 0.8, precision: 0.4 } }))
      if (s === 1) records.push(consistentRecord({ turn: 99, pal: { activeCases: 1, anyNeedsUser: true, anyStalled: false, hasPlannedProbes: false } }))
      if (s === 2) records.push(consistentRecord({ turn: 99, evidence: { hasVerificationDebt: true, deliveryStatus: 'failed', consecutiveFailures: 0 } }))
      if (s === 3) records.push(consistentRecord({ turn: 99, user: { intervened: true } }))
      if (s === 4) records.push(consistentRecord({ turn: 99 }, { level: 3, shouldAbort: true, abortCause: 'no-tool' }))
      sessions.push(session(`s${s}`, records))
    }
    const report = buildAdmissionReport(sessions)
    assert.equal(report.admitted, true, `missing: ${report.missing.join('; ')}`)
    assert.equal(report.sessionCount, 15)
    assert.ok(report.recordCount >= 300)
    for (const key of FRAME_CLASS_KEYS) assert.ok(report.classCounts[key] >= 1, `${key} 应有覆盖`)
  })

  it('session/记录数不足、反例缺失、硬线违规逐项列入 missing', () => {
    const bad = consistentRecord()
    bad.structureFlow = { ...bad.structureFlow!, relaxation: 0.4 } // relaxation 越界 → violation
    const report = buildAdmissionReport([session('only', [bad])])
    assert.equal(report.admitted, false)
    assert.ok(report.missing.some(m => m.includes('session 数不足：1/15')))
    assert.ok(report.missing.some(m => m.includes('记录数不足：1/300')))
    assert.ok(report.missing.some(m => m.includes('反例缺失')))
    assert.ok(report.missing.some(m => m.includes('硬线违规')))
  })

  it('degraded 比例：EFE/sensorium 缺失的记录计入 degraded', () => {
    const healthy = consistentRecord()
    const degraded = consistentRecord({ efe: null })
    const report = buildAdmissionReport([session('a', [healthy, degraded])])
    assert.equal(report.degradedCount, 1)
    assert.ok(Math.abs(report.degradedRatio - 0.5) < 1e-9)
  })

  it('确定性：同输入两次聚合深相等', () => {
    const sessions = [session('a', [consistentRecord(), consistentRecord({ turn: 9 })], 1)]
    assert.deepEqual(buildAdmissionReport(sessions), buildAdmissionReport(sessions))
  })
})

describe('parseFrameLines — 截断容错', () => {
  it('parse 失败的行跳过并计 warning，其余记录照常解析', () => {
    const good = JSON.stringify(consistentRecord())
    const raw = [good, '{"kind":"cognitive-frame","v":1,"turn":9,"trunc', good].join('\n') + '\n'
    const { records, parseWarnings } = parseFrameLines(raw)
    assert.equal(records.length, 2)
    assert.equal(parseWarnings, 1)
  })

  it('非 frame 记录（kind 不符）计 warning 不入账', () => {
    const raw = JSON.stringify({ kind: 'vitals-lite', turn: 1 }) + '\n' + JSON.stringify(consistentRecord()) + '\n'
    const { records, parseWarnings } = parseFrameLines(raw)
    assert.equal(records.length, 1)
    assert.equal(parseWarnings, 1)
  })

  it('空文本 → 零记录零 warning', () => {
    assert.deepEqual(parseFrameLines(''), { records: [], parseWarnings: 0 })
  })
})
