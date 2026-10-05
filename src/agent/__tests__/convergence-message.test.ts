/**
 * convergence-message 单测（Layer 2，2026-10-05）。
 *
 * 覆盖 MessageVariant 的全部分支——它是发射门判"方向是否变化"的唯一凭证。
 * 分支走错会让冷却重置判据失真（这正是 Layer 2 修的原缺陷：文案改词被
 * 误读为改道）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildInjectedMessage } from '../convergence-message.js'
import type { ConvergenceSignals } from '../convergence-detector.js'

const SIGNALS: ConvergenceSignals = {
  editRatio: 0,
  targetNovelty: 0.1,
  toolEntropy: 0.2,
  errorPenalty: 1,
  tokenEfficiency: 0,
  oscillationPenalty: 1,
  textRepetitionPenalty: 1,
}

const TIER = { maxTurns: 30, nLow: 8, nMid: 14, nHigh: 20, signalWindow: 6, label: '200K' }

type Opts = {
  level?: 2 | 3
  signals?: ConvergenceSignals
  deliveryStatus?: 'verified' | 'blocked' | 'failed'
  noToolTurnCount?: number
  productiveStagnation?: boolean
  activityMode?: 'diagnostic' | 'build'
}

function build(o: Opts = {}) {
  return buildInjectedMessage(
    o.level ?? 2,
    0.3,
    o.signals ?? SIGNALS,
    'plan',
    TIER,
    o.deliveryStatus,
    o.noToolTurnCount,
    o.productiveStagnation,
    0,
    o.activityMode,
  )
}

describe('convergence-message — MessageVariant 分支', () => {
  it('productiveStagnation + diagnostic → stagnation-diagnostic', () => {
    assert.equal(build({ productiveStagnation: true, activityMode: 'diagnostic' }).variant, 'stagnation-diagnostic')
  })

  it('productiveStagnation + build → stagnation-build', () => {
    assert.equal(build({ productiveStagnation: true, activityMode: 'build' }).variant, 'stagnation-build')
  })

  it('no-tool 僵局 → no-tool', () => {
    assert.equal(build({ noToolTurnCount: 2 }).variant, 'no-tool')
  })

  it('验证通过（level 2）→ delivery-complete', () => {
    assert.equal(build({ deliveryStatus: 'verified', level: 2 }).variant, 'delivery-complete')
  })

  it('门禁受阻 → gate-blocked', () => {
    assert.equal(build({ deliveryStatus: 'blocked' }).variant, 'gate-blocked')
  })

  it('门禁失败 → gate-failed', () => {
    assert.equal(build({ deliveryStatus: 'failed' }).variant, 'gate-failed')
  })

  it('编辑在落地且失败率低（level 2）→ route-confirm', () => {
    assert.equal(
      build({ signals: { ...SIGNALS, editRatio: 0.3, errorPenalty: 0.9 } }).variant,
      'route-confirm',
    )
  })

  it('诊断态通用变体 → diagnostic', () => {
    assert.equal(build({ activityMode: 'diagnostic' }).variant, 'diagnostic')
  })

  it('兜底 → generic', () => {
    assert.equal(build().variant, 'generic')
  })

  it('同一变体的文案改词不改 variant —— 发射门的方向凭证不随措辞漂移', () => {
    // 同参数两次构造：variant 必须逐字相等（Loop 侧据此判 changedDirection）。
    const a = build({ productiveStagnation: true, activityMode: 'diagnostic' })
    const b = build({ productiveStagnation: true, activityMode: 'diagnostic' })
    assert.equal(a.variant, b.variant)
    assert.ok(a.text.length > 0, '文案仍须产出')
  })
})
