import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  touchActivity as rawTouch,
  beginRun, withActivityRun, finishRun,
  getLastActivity,
  getRecentActivities,
  markIdle as rawIdle,
  clearActivity,
  installStallObserver,
  _resetStallObserverForTest,
  type StallObserverHandle,
} from '../stall-observer.js'

const touchActivity = (key: string, source: string) => {
  if (!getLastActivity(key).generation) beginRun(key, key)
  withActivityRun(key, key, () => rawTouch(key, source))
}
const markIdle = (key: string) => withActivityRun(key, key, () => rawIdle(key))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('no warn while activity is fresh (tick within threshold)', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 200, warn: (m) => warned.push(m) })
  try {
    for (let i = 0; i < 5; i++) {
      touchActivity('session-a', `evt:${i}`)
      await sleep(30)
    }
    assert.equal(warned.length, 0, 'fresh activity must not trigger the stall warning')
  } finally {
    handle.dispose()
  }
})

test('warns once when a session goes silent past the threshold, naming the last source', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 50, warn: (m) => warned.push(m) })
  try {
    touchActivity('session-a', 'tool:write_file:start')
    await sleep(120) // well past 50ms threshold
    assert.equal(warned.length, 1, 'exactly one warning for the silent period')
    assert.ok(warned[0]!.includes('session-a'), `warning must name the stalled session: ${warned[0]}`)
    assert.ok(warned[0]!.includes('tool:write_file:start'), `warning must name the last activity source: ${warned[0]}`)
  } finally {
    handle.dispose()
  }
})

test('multi-session isolation: an active session does not mask a stalled one', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 50, warn: (m) => warned.push(m) })
  try {
    touchActivity('session-stalled', 'tool:write_file:start')
    // Session-b stays active across several ticks — its touches must NOT reset
    // session-stalled's silent counter.
    for (let i = 0; i < 6; i++) {
      touchActivity('session-active', `evt:${i}`)
      await sleep(25)
    }
    assert.ok(warned.some((m) => m.includes('session-stalled')), `stalled session must be reported: ${warned}`)
    assert.ok(!warned.some((m) => m.includes('session-active')), `active session must not be reported: ${warned}`)
  } finally {
    handle.dispose()
  }
})

test('dispose stops the observer', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 20, warn: (m) => warned.push(m) })
  handle.dispose()
  touchActivity('session-x', 'evt:1')
  await sleep(80)
  assert.equal(warned.length, 0, 'no warnings after dispose')
})

test('getLastActivity returns the most recent touch', () => {
  touchActivity('session-a', 'evt:5')
  const a = getLastActivity('session-a')
  assert.equal(a.source, 'evt:5')
  assert.ok(Math.abs(Date.now() - a.ts) < 1000)
})

test('late activity cannot reactivate a completed run', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 40, warn: (m) => warned.push(m) })
  try {
    touchActivity('session-a', 'tool:write_file:end')
    markIdle('session-a') // turn finished — awaiting the user, not stalled
    await sleep(120) // well past the threshold, but idle must NOT warn
    assert.equal(warned.length, 0, `idle session must not warn: ${warned}`)

    touchActivity('session-a', 'evt:hook_result')
    await sleep(70)
    assert.equal(warned.length, 0, 'late hook must not reactivate monitoring')
    beginRun('session-a', 'session-a')
    touchActivity('session-a', 'evt:user-message')
    await sleep(120)
    assert.equal(warned.length, 1, 'activity after idle must be monitored again')
    assert.ok(warned[0]!.includes('session-a'))
  } finally {
    handle.dispose()
  }
})

test('clearActivity removes a finished session so it never warns again', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 40, warn: (m) => warned.push(m) })
  try {
    touchActivity('worker-batch-0-abc', 'tool:glob:end')
    clearActivity('worker-batch-0-abc') // worker session finished
    await sleep(120)
    assert.equal(warned.length, 0, `cleared session must not warn: ${warned}`)

    // A later fresh run of the same session id is monitored anew.
    touchActivity('worker-batch-0-abc', 'tool:glob:start')
    await sleep(120)
    assert.equal(warned.length, 1, 're-touched key after clear must be monitored again')
  } finally {
    handle.dispose()
  }
})

 test('an old generation cannot refresh or finish a new run', () => {
  _resetStallObserverForTest()
  beginRun('s', 'old')
  beginRun('s', 'new')
  withActivityRun('s', 'old', () => { rawTouch('s', 'late'); rawIdle('s') })
  assert.equal(getLastActivity('s').source, 'run:start')
  assert.equal(getLastActivity('s').idle, false)
  finishRun('s', 'new')
  rawTouch('s', 'unscoped hook')
  assert.equal(getLastActivity('s').idle, true)
  _resetStallObserverForTest()
})

// ── 环形缓冲：卡顿前归因（P1）──────────────────────────────────────
test('getRecentActivities 记录打点的时间/key/来源', () => {
  _resetStallObserverForTest()
  const t0 = Date.now()
  touchActivity('session-a', 'tool:grep:start')
  touchActivity('session-b', 'tool:write_file:start')
  const recent = getRecentActivities(1000)
  assert.deepEqual(
    recent.map((r) => [r.key, r.source]),
    [['session-a', 'tool:grep:start'], ['session-b', 'tool:write_file:start']],
  )
  assert.ok(recent.every((r) => r.ts >= t0 && r.ts <= Date.now() + 5), '时间戳应是打点时刻')
  _resetStallObserverForTest()
})

test('环形缓冲上限 64 条，最老的先淘汰', () => {
  _resetStallObserverForTest()
  touchActivity('s', 'run:marker')
  for (let i = 0; i < 80; i++) touchActivity('s', `evt:${i}`)
  const recent = getRecentActivities(60_000)
  assert.equal(recent.length, 64, '缓冲不得无界增长')
  assert.equal(recent[0]!.source, 'evt:16', '淘汰最老的，保留最近 64 条')
  assert.equal(recent.at(-1)!.source, 'evt:79')
  _resetStallObserverForTest()
})

test('getRecentActivities 支持 anchor 窗口（「卡顿开始前 N ms」）', async () => {
  _resetStallObserverForTest()
  touchActivity('s', 'before')
  const anchor = Date.now()
  await sleep(30)
  touchActivity('s', 'after')
  // 右界 = anchor：卡顿开始**之后**的打点不得混入「卡顿前」归因
  assert.deepEqual(
    getRecentActivities(200, anchor).map((r) => r.source),
    ['before'],
    'anchor 右界之后的打点不得混入卡顿前归因',
  )
  // 左界：窗口落在所有打点之前 → 空（lookback 从 anchor 往前算）
  assert.deepEqual(
    getRecentActivities(10, anchor - 500),
    [],
    '窗口未覆盖任何打点时必须为空',
  )
  // 不传 anchor = 以「现在」为右界：两条都在窗口内（证明上一步的排除来自 anchor 而非容量）
  assert.deepEqual(
    getRecentActivities(200).map((r) => r.source),
    ['before', 'after'],
  )
  _resetStallObserverForTest()
})

test('未通过守卫的调用不进缓冲（归因只认真实进展）', () => {
  _resetStallObserverForTest()
  touchActivity('session-a', 'tool:start') // 守卫通过（run 活跃）→ 记录
  // 注意：本项目测试辅助里的 touchActivity 首次会 beginRun；beginRun 不写缓冲。
  markIdle('session-a')
  touchActivity('session-a', 'evt:late-hook') // idle 后被守卫拒绝 → 不记录
  assert.deepEqual(getRecentActivities(1000).map((r) => r.source), ['tool:start'])
  _resetStallObserverForTest()
})
