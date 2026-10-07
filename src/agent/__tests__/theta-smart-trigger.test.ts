import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createThetaController, type ThetaControllerHost, type ThetaTelemetryState } from '../theta-controller.js'
import type { ThetaCheckResult } from '../theta-check.js'

/** 创建测试用的 mock host */
function createMockHost(overrides?: Partial<ThetaTelemetryState>): ThetaControllerHost {
  const telemetry: ThetaTelemetryState = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
    consecutiveTimeouts: 0,
    cooldownUntilTurn: 0,
    suppressedCount: 0,
    outcomes: {} as Record<string, number>,
    consecutiveNoFreshVerdict: 0,
    triggeredRuns: 0,
    ...overrides,
  }

  return {
    cwd: '/test',
    thetaCheckInFlight: false,
    thetaRequestsThisTurn: 0,
    thetaTelemetry: telemetry,
    session: { getTurnCount: () => 10 },
    repairHintTracker: { recordFailure: () => {} },
  }
}

describe('智能触发逻辑 (shouldTriggerOnMiss)', () => {
  it('连续 3 次 no-fresh-verdict 触发真跑', async () => {
    const host = createMockHost({ consecutiveNoFreshVerdict: 3 })

    let triggeredWithMiss = false
    const mockRunner = async (options: any) => {
      if (typeof options === 'object' && options.triggerOnMiss) {
        triggeredWithMiss = true
      }
      return {
        errors: [],
        durationMs: 0,
        timedOut: false,
        outcome: 'ok',
      } as ThetaCheckResult
    }

    const controller = createThetaController(host, mockRunner)
    controller('test-reason')

    // 等待异步完成
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.ok(triggeredWithMiss, 'Should trigger with triggerOnMiss=true after 3 consecutive no-fresh-verdict')
  })

  it('连续 2 次 no-fresh-verdict 不触发真跑', async () => {
    const host = createMockHost({ consecutiveNoFreshVerdict: 2 })

    let triggeredWithMiss = false
    const mockRunner = async (options: any) => {
      if (typeof options === 'object' && options.triggerOnMiss) {
        triggeredWithMiss = true
      }
      return {
        errors: [],
        durationMs: 0,
        timedOut: false,
        outcome: 'no-fresh-verdict',
      } as ThetaCheckResult
    }

    const controller = createThetaController(host, mockRunner)
    controller('test-reason')

    // 等待异步完成
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.ok(!triggeredWithMiss, 'Should NOT trigger with triggerOnMiss=true when only 2 consecutive no-fresh-verdict')
  })

  it('会话接近上限（剩余 < 10）且有 no-fresh-verdict 时触发', async () => {
    const host = createMockHost({
      requestedCount: 35, // 40 - 35 = 5 剩余
      consecutiveNoFreshVerdict: 1,
    })

    let triggeredWithMiss = false
    const mockRunner = async (options: any) => {
      if (typeof options === 'object' && options.triggerOnMiss) {
        triggeredWithMiss = true
      }
      return {
        errors: [],
        durationMs: 0,
        timedOut: false,
        outcome: 'ok',
      } as ThetaCheckResult
    }

    const controller = createThetaController(host, mockRunner)
    controller('test-reason')

    // 等待异步完成
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.ok(triggeredWithMiss, 'Should trigger when session is near limit (< 10 remaining)')
  })

  it('成功结果清零 consecutiveNoFreshVerdict', async () => {
    const host = createMockHost({ consecutiveNoFreshVerdict: 5 })

    const mockRunner = async () => {
      return {
        errors: [],
        durationMs: 100,
        timedOut: false,
        outcome: 'ok',
      } as ThetaCheckResult
    }

    const controller = createThetaController(host, mockRunner)
    controller('test-reason')

    // 等待异步完成
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.equal(host.thetaTelemetry.consecutiveNoFreshVerdict, 0, 'ok outcome should clear consecutiveNoFreshVerdict')
  })

  it('no-fresh-verdict 累加 consecutiveNoFreshVerdict', async () => {
    const host = createMockHost({ consecutiveNoFreshVerdict: 2 })

    const mockRunner = async () => {
      return {
        errors: [],
        durationMs: 0,
        timedOut: false,
        outcome: 'no-fresh-verdict',
      } as ThetaCheckResult
    }

    const controller = createThetaController(host, mockRunner)
    controller('test-reason')

    // 等待异步完成
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.equal(host.thetaTelemetry.consecutiveNoFreshVerdict, 3, 'no-fresh-verdict outcome should increment consecutiveNoFreshVerdict')
  })
})
