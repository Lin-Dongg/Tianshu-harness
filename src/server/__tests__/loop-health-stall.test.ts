/**
 * P1 —— 事件循环卡顿归因（漂移检测）。
 *
 * 现场：多进程 worker 并发跑工具时，事件循环被同步段卡住 12–19s 共 4 次；
 * 现有 [loop-lag] 走 30s 窗口最大值，重复打印同一尖峰、且只在卡顿**结束后**
 * 的采样里可见——定位不了「哪个活动造成的」。
 *
 * 新检测：250ms 定时器测实际间隔（漂移），> 阈值即进入「卡顿中」状态、只记
 * 一条（恢复前不重复），内容带开始时间、持续时长、堆/RSS、以及**卡顿开始前
 * 1 秒内碰过的活动**（stall-observer 环形缓冲）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LoopStallDetector, type LoopStallEvent } from '../loop-health.js'
import {
  touchActivity,
  beginRun,
  withActivityRun,
  _resetStallObserverForTest,
} from '../../agent/stall-observer.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const busyWait = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* block */ } }

test('忙等阻塞 > 阈值：只记一条日志，并带上卡顿前碰过的活动', async () => {
  _resetStallObserverForTest()
  beginRun('session-a', 'session-a')
  withActivityRun('session-a', 'session-a', () => touchActivity('session-a', 'tool:grep:start'))

  const stalls: LoopStallEvent[] = []
  const logs: string[] = []
  const det = new LoopStallDetector({
    intervalMs: 25,
    stallThresholdMs: 200,
    attributionWindowMs: 1000,
    warn: (m) => logs.push(m),
    onStall: (e) => stalls.push(e),
  })
  det.start()
  try {
    busyWait(1500) // 同步阻塞：250ms 定时器被饿死
    await sleep(200)
    assert.equal(stalls.length, 1, `一次卡顿只记一条: ${JSON.stringify(logs)}`)
    assert.equal(logs.length, 1)
    const e = stalls[0]!
    assert.ok(e.stalledMs >= 1000, `持续时长应反映真实阻塞: ${e.stalledMs}ms`)
    assert.ok(e.startedAt > 0, '应带卡顿开始时间')
    assert.ok(e.heapUsedMb > 0 && e.rssMb > 0, '应带堆/RSS')
    assert.ok(
      e.recentActivities.some((a) => a.source === 'tool:grep:start'),
      `应带上卡顿前碰过的活动: ${JSON.stringify(e.recentActivities)}`,
    )
    assert.ok(logs[0]!.includes('tool:grep:start'), `日志文本应含归因: ${logs[0]}`)
  } finally {
    det.stop()
  }
})

test('恢复正常后再次卡顿可再记一条（防重复打印，不防漏报）', async () => {
  _resetStallObserverForTest()
  const logs: string[] = []
  const det = new LoopStallDetector({ intervalMs: 25, stallThresholdMs: 200, warn: (m) => logs.push(m) })
  det.start()
  try {
    busyWait(600)
    await sleep(200) // 恢复：若干正常 tick 会清「卡顿中」状态
    assert.equal(logs.length, 1, `第一次卡顿一条: ${JSON.stringify(logs)}`)
    busyWait(600)
    await sleep(200)
    assert.equal(logs.length, 2, `恢复后第二次卡顿应再记一条: ${JSON.stringify(logs)}`)
  } finally {
    det.stop()
  }
})

test('无卡顿时零日志（健康路径零开销）', async () => {
  _resetStallObserverForTest()
  const logs: string[] = []
  const det = new LoopStallDetector({ intervalMs: 20, stallThresholdMs: 300, warn: (m) => logs.push(m) })
  det.start()
  try {
    await sleep(400)
    assert.equal(logs.length, 0, `未卡顿不得写日志: ${JSON.stringify(logs)}`)
  } finally {
    det.stop()
  }
})
