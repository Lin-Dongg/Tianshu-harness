import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCognitiveFrameRecord,
  buildCognitiveFrameLiteRecord,
  replayCognitiveFrames,
  COGNITIVE_FRAME_KIND,
  COGNITIVE_FRAME_LITE_KIND,
  type CognitiveFrameRecord,
} from '../cognitive-frame-replay.js'
import { assembleCognitiveFrame, projectStructureFlowInputs, type CognitiveFrameInput } from '../cognitive-frame.js'
import { computeStructureFlowControl } from '../structure-flow-controller.js'

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

/** 构造一条自洽记录：装配 → 投影 → 控制器 → 记录（经 JSON 往返模拟落盘）。 */
function consistentRecord(overrides: Partial<CognitiveFrameInput> = {}): CognitiveFrameRecord {
  const frame = assembleCognitiveFrame(frameInput(overrides))
  const inputs = projectStructureFlowInputs(frame)
  const sf = inputs ? computeStructureFlowControl(inputs) : null
  const record = buildCognitiveFrameRecord(frame, sf, { level: 0, shouldAbort: false, abortCause: undefined, messageVariant: null })
  return JSON.parse(JSON.stringify(record)) as CognitiveFrameRecord
}

describe('buildCognitiveFrameRecord / lite', () => {
  it('full 记录含 v/facts/quality/输出摘要；kind 正确', () => {
    const record = consistentRecord()
    assert.equal(record.kind, COGNITIVE_FRAME_KIND)
    assert.equal(record.v, 2)
    assert.equal(record.facts.progress.todoCompletedDelta, 2)
    assert.equal(record.quality.efe, 'measured')
    assert.equal(record.structureFlow?.mode, 'flow')
    assert.equal(record.convergence?.abortCause, null)
  })

  it('lite 记录单行 <200B，quality 压缩码按固定顺序', () => {
    const frame = assembleCognitiveFrame(frameInput({ efe: null, sensorium: null }))
    const lite = buildCognitiveFrameLiteRecord(frame, null, { level: 1, shouldAbort: false, abortCause: undefined })
    assert.equal(lite.kind, COGNITIVE_FRAME_LITE_KIND)
    assert.ok(Buffer.byteLength(JSON.stringify(lite), 'utf-8') < 200, 'lite 行必须 <200B')
    // 顺序 efe,sensorium,flow,pal,evidence,user,plan,progress → x x m m m m m m
    assert.equal(lite.q, 'xxmmmmmm')
    assert.equal(lite.fp.length, 12)
  })
})

describe('replayCognitiveFrames', () => {
  it('自洽记录 → 零 divergence、零 violation；两次回放深相等（确定性）', () => {
    const records = [consistentRecord(), consistentRecord({ turn: 9, progress: { todoCompletedDelta: 1 } })]
    const a = replayCognitiveFrames(records)
    const b = replayCognitiveFrames(records)
    assert.deepEqual(a, b)
    assert.equal(a.checkedCount, 2)
    assert.deepEqual(a.divergences, [])
    assert.deepEqual(a.violations, [])
  })

  it('篡改 fact → fingerprint divergence（facts 完整性对账）', () => {
    const record = consistentRecord()
    record.facts.progress.todoCompletedDelta = 99
    const report = replayCognitiveFrames([record])
    assert.ok(report.divergences.some(d => d.field === 'inputFingerprint'))
  })

  it('篡改输出摘要 → projection divergence（重算抓到输出漂移）', () => {
    const record = consistentRecord()
    record.structureFlow = { ...record.structureFlow!, relaxation: 0.1, mode: 'balanced' }
    // 同步 fingerprint 无关——fingerprint 只覆盖 facts，输出漂移由重算比对抓。
    const report = replayCognitiveFrames([record])
    assert.ok(report.divergences.some(d => d.field === 'structureFlow.relaxation'))
    assert.ok(report.divergences.some(d => d.field === 'structureFlow.mode'))
  })

  it('EFE 缺失记录：structureFlow=null 自洽通过，turn 报 degraded 不报 healthy', () => {
    const frame = assembleCognitiveFrame(frameInput({ efe: null }))
    const record = JSON.parse(JSON.stringify(
      buildCognitiveFrameRecord(frame, null, { level: 0, shouldAbort: false, abortCause: undefined, messageVariant: null }),
    )) as CognitiveFrameRecord
    const report = replayCognitiveFrames([record])
    assert.deepEqual(report.divergences, [])
    assert.deepEqual(report.degradedTurns, [8])
  })

  it('缺 sensorium → degraded；健康记录不进 degraded', () => {
    const degraded = consistentRecord({ sensorium: null, flow: { score: null, sampleCount: 0, requiredSamples: 4 } })
    const healthy = consistentRecord({ turn: 9 })
    const report = replayCognitiveFrames([degraded, healthy])
    assert.deepEqual(report.degradedTurns, [8])
  })

  it('硬线机检：硬收紧事实为真而 relaxation>0 → violation（四类 + 连续失败）', () => {
    const cases: Array<[string, Partial<CognitiveFrameInput>]> = [
      ['pal.anyNeedsUser', { pal: { activeCases: 1, anyNeedsUser: true, anyStalled: false, hasPlannedProbes: false } }],
      ['pal.anyStalled', { pal: { activeCases: 1, anyNeedsUser: false, anyStalled: true, hasPlannedProbes: false } }],
      ['user.intervened', { user: { intervened: true } }],
      ['evidence.hasVerificationDebt', { evidence: { hasVerificationDebt: true, deliveryStatus: 'failed', consecutiveFailures: 0 } }],
      ['evidence.consecutiveFailures>=2', { evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 2 } }],
    ]
    for (const [name, overrides] of cases) {
      const record = consistentRecord(overrides)
      // 伪造越线输出：硬收紧事实在场却记录了 relaxation>0。
      record.structureFlow = { mode: 'flow', relaxation: 0.2, planRecommendation: 'none', tddRecommendation: 'neutral', reasons: [] }
      const report = replayCognitiveFrames([record])
      assert.ok(
        report.violations.some(v => v.rule === 'hard-tighten-bypassed' && v.detail.includes(name)),
        `${name} 应触发 hard-tighten-bypassed`,
      )
    }
  })

  it('硬线机检：relaxation 越界 [0, 0.25] → violation', () => {
    const record = consistentRecord()
    record.structureFlow = { ...record.structureFlow!, relaxation: 0.4 }
    const report = replayCognitiveFrames([record])
    assert.ok(report.violations.some(v => v.rule === 'relaxation-range'))
  })

  it('未知 schema 版本 → divergence(v)，不猜语义', () => {
    const record = consistentRecord()
    ;(record as { v: number }).v = 99
    const report = replayCognitiveFrames([record])
    assert.ok(report.divergences.some(d => d.field === 'v'))
  })

  it('无副作用：回放不修改传入记录', () => {
    const record = consistentRecord()
    const before = JSON.stringify(record)
    replayCognitiveFrames([record])
    assert.equal(JSON.stringify(record), before)
  })
})
