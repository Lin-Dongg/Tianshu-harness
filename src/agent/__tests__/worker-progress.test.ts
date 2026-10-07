import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProgressTracker, recordToolCall, shouldConverge, pickSteer, HARD_CONVERGE_STREAK } from '../worker-progress.js'

/**
 * worker 空转检测（2026-10-06 verifier 空转事故）。
 *
 * 事故形态：verifier 在"找 ledger"死胡同里换着花样 grep，直到预算耗尽被中断。
 * 它每次换 pattern（指纹不同），所以单靠"同参数重复"抓不到——判据必须是
 * **"这次调用有没有产出新信息"**（零命中 = 无新信息），指纹重复只是其中一种。
 */
describe('worker 空转检测', () => {
  it('连续零结果（即使每次 pattern 都不同）→ 达到阈值该收敛', () => {
    let t = createProgressTracker()
    for (const fp of ['grep:a', 'grep:b', 'grep:c']) t = recordToolCall(t, fp, true)
    assert.equal(t.noProgressStreak, 3)
    assert.equal(shouldConverge(t), true)
  })

  it('同指纹重复也计入（重读同一文件 / 同 pattern 重跑）', () => {
    let t = createProgressTracker()
    for (let i = 0; i < 4; i++) t = recordToolCall(t, 'read:same.ts', false)
    assert.equal(t.noProgressStreak, 3)
    assert.equal(shouldConverge(t), true)
  })

  it('任何一次有新增信息 → 计数清零（不误杀有进展的探索）', () => {
    let t = createProgressTracker()
    t = recordToolCall(t, 'grep:a', true)
    t = recordToolCall(t, 'grep:b', true)
    t = recordToolCall(t, 'grep:c', false) // 这次有命中
    t = recordToolCall(t, 'grep:d', false) // 继续有收获
    assert.equal(t.noProgressStreak, 0)
    assert.equal(shouldConverge(t), false)
  })

  it('未达阈值不触发', () => {
    let t = createProgressTracker()
    t = recordToolCall(t, 'grep:a', true)
    t = recordToolCall(t, 'grep:b', true)
    assert.equal(shouldConverge(t), false)
  })

  it('阈值是 3（与认知场 core rule「连续 3 次无新增信息」同一判据）', () => {
    assert.equal(HARD_CONVERGE_STREAK, 3)
  })
})

/**
 * steer 选取——把 runOnce 里的接线逻辑抽成纯函数后单测。
 * 这是"空转 → 收敛 steer"这条接线的行为证据：回调装配本身不好直接测，
 * 但它做的决策（收敛优先 / 只发一次 / 回落外部）在这里被钉死。
 */
describe('空转收敛 steer 的选取', () => {
  function converged() {
    let t = createProgressTracker()
    for (const fp of ['grep:a', 'grep:b', 'grep:c']) t = recordToolCall(t, fp, true)
    return t
  }

  it('达到阈值 → 发收敛 steer，且不再调外部通道（收敛优先）', () => {
    let externalCalls = 0
    const r = pickSteer(converged(), false, () => { externalCalls++; return 'external-steer' })
    assert.match(r.steer ?? '', /收敛警告/)
    assert.equal(r.convergenceSent, true)
    assert.equal(externalCalls, 0)
  })

  it('已发过一次 → 回落外部通道（不重复刷收敛）', () => {
    const r = pickSteer(converged(), true, () => 'external-steer')
    assert.equal(r.steer, 'external-steer')
    assert.equal(r.convergenceSent, true)
  })

  it('未达阈值 → 回落外部通道，不标记已发', () => {
    const r = pickSteer(createProgressTracker(), false, () => 'external-steer')
    assert.equal(r.steer, 'external-steer')
    assert.equal(r.convergenceSent, false)
  })

  it('无外部通道且未空转 → null（不注入）', () => {
    const r = pickSteer(createProgressTracker(), false, () => null)
    assert.equal(r.steer, null)
  })
})
