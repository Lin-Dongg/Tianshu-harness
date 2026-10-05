import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getOrCreateSession, closeSession, __resetSessionForTest } from '../session.js'
import type {
  BrowserDebugDriver,
  BrowserInputEvent,
  DriverLaunchOptions,
  ScreencastFrame,
  ScreencastOptions,
} from '../driver.js'

/** 基线能力的假 driver——不含帧流方法（模拟不支持 CDP screencast 的实现）。 */
class BaseFakeDriver implements BrowserDebugDriver {
  closed = false
  alive = true
  isAlive() { return this.alive }
  async goto() {}
  async evaluate() { return '' }
  async screenshot() { return Buffer.from('') }
  async snapshot() { return '' }
  async click() {}
  async type() {}
  async press() {}
  async selectOption() { return [] as string[] }
  async hover() {}
  async scroll() {}
  async waitForSelector() {}
  async waitForLoadState() {}
  async reload() {}
  async goBack() { return true }
  async goForward() { return true }
  async cookies() { return [] }
  async storage() { return {} }
  async addCookie() {}
  async clearCookies() {}
  async setStorage() {}
  async clearStorage() {}
  async setViewport() {}
  viewportSize() { return { width: 1280, height: 800 } }
  currentUrl() { return 'about:blank' }
  pageUrls() { return ['about:blank'] }
  async bringToFront() {}
  async close() { this.closed = true }
}

/** 带帧流能力的假 driver，记录起停次数与最近一次帧回调。 */
class ScreencastFakeDriver extends BaseFakeDriver {
  startCount = 0
  stopCount = 0
  lastSink: ((f: ScreencastFrame) => void) | null = null
  inputEvents: BrowserInputEvent[] = []
  failStart = false

  async startScreencast(_opts: ScreencastOptions, onFrame: (f: ScreencastFrame) => void): Promise<void> {
    this.startCount += 1
    if (this.failStart) throw new Error('startScreencast failed')
    this.lastSink = onFrame
  }
  async stopScreencast(): Promise<void> {
    this.stopCount += 1
    this.lastSink = null
  }
  async captureFrame(): Promise<ScreencastFrame | null> {
    return { data: 'AAAA', width: 800, height: 600, seq: 1 }
  }
  async dispatchInput(evt: BrowserInputEvent): Promise<void> {
    this.inputEvents.push(evt)
  }
}

function factoryFor(make: () => BrowserDebugDriver) {
  return async (_o: DriverLaunchOptions): Promise<BrowserDebugDriver> => make()
}

async function openWith(key: string, driver: BrowserDebugDriver) {
  return await getOrCreateSession({
    sessionKey: key,
    headless: true,
    userDataDir: `profile-${key}`,
    driverFactory: factoryFor(() => driver),
  })
}

test('无帧流能力的 driver：能力探测全为否，退订是 no-op', async () => {
  __resetSessionForTest()
  const s = await openWith('k1', new BaseFakeDriver())

  const unsub = await s.subscribeFrames(() => {})
  assert.equal(s.streaming, false)
  assert.equal(await s.captureFrame(), null)
  assert.equal(await s.dispatchInput({ type: 'mouseMoved', x: 1, y: 1 }), false)

  unsub() // 不得抛
  await closeSession('k1')
})

test('引用计数：首个订阅启动推流，后续复用，全退订才停', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k2', driver)

  const unsubA = await s.subscribeFrames(() => {})
  assert.equal(driver.startCount, 1)
  assert.equal(s.streaming, true)

  const unsubB = await s.subscribeFrames(() => {})
  assert.equal(driver.startCount, 1, '第二个订阅者必须复用同一条 screencast')

  unsubA()
  assert.equal(driver.stopCount, 0, '仍有订阅者时不得停播')
  assert.equal(s.streaming, true)

  unsubB()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(driver.stopCount, 1)
  assert.equal(s.streaming, false)

  await closeSession('k2')
})

test('退订幂等：重复调用不会多停一次推流', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k3', driver)

  const unsub = await s.subscribeFrames(() => {})
  unsub()
  unsub()
  unsub()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(driver.stopCount, 1)

  await closeSession('k3')
})

test('帧分发给全部订阅者；单个订阅者抛错不影响其余', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k4', driver)

  const got: number[] = []
  await s.subscribeFrames(() => { throw new Error('subscriber blew up') })
  await s.subscribeFrames((f) => { got.push(f.seq) })

  driver.lastSink?.({ data: 'X', width: 10, height: 10, seq: 7 })
  assert.deepEqual(got, [1], '坏的订阅者不应吞掉其他订阅者的帧')

  await closeSession('k4')
})

test('startScreencast 失败：回滚订阅并如实抛出', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  driver.failStart = true
  const s = await openWith('k5', driver)

  await assert.rejects(() => s.subscribeFrames(() => {}), /startScreencast failed/)
  assert.equal(s.streaming, false, '启动失败后不得留下「正在推流」的假状态')

  // 回滚干净：修好之后再订阅仍能正常启动。
  driver.failStart = false
  const unsub = await s.subscribeFrames(() => {})
  assert.equal(s.streaming, true)
  unsub()

  await closeSession('k5')
})

test('close 清空订阅并复位推流标记', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k6', driver)
  await s.subscribeFrames(() => {})
  assert.equal(s.streaming, true)

  await closeSession('k6')
  assert.equal(s.streaming, false, '会话关闭后推流标记必须复位')
})

test('dispatchInput 透传事件；captureFrame 透传帧', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k7', driver)

  assert.equal(await s.dispatchInput({ type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 }), true)
  assert.deepEqual(driver.inputEvents, [{ type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 }])

  const frame = await s.captureFrame()
  assert.equal(frame?.seq, 1)

  await closeSession('k7')
})

test('W2.1 会话重建：帧订阅跨会话迁移，面板无需重连，退订清在新 driver 上', async () => {
  __resetSessionForTest()
  const first = new ScreencastFakeDriver()
  const second = new ScreencastFakeDriver()
  let useSecond = false
  const factory = async (_o: DriverLaunchOptions): Promise<BrowserDebugDriver> => (useSecond ? second : first)

  const s1 = await getOrCreateSession({ sessionKey: 'k8', headless: true, userDataDir: 'p', driverFactory: factory })
  const got: number[] = []
  const unsub = await s1.subscribeFrames((f) => { got.push(f.seq) })
  assert.equal(first.startCount, 1)

  // 浏览器死亡：与真实 driver 的 isAlive=false 同路径
  first.alive = false
  useSecond = true
  const s2 = await getOrCreateSession({ sessionKey: 'k8', headless: true, userDataDir: 'p', driverFactory: factory })

  assert.notEqual(s2, s1, '死会话必须重建')
  assert.equal(s2.frames, s1.frames, '重建必须接管同一个 FrameStream（订阅集合跨会话共享）')
  assert.equal(second.startCount, 1, '新 driver 必须重启推流')
  assert.deepEqual(got, [1], '接管时要补一帧（静态页不会自己产帧）')

  second.lastSink?.({ data: 'Y', width: 1, height: 1, seq: 8 })
  assert.deepEqual(got, [1, 2], '面板继续收到新会话的帧，无需重连')

  unsub()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.stopCount, 1, '退订必须停在新 driver 上（旧实现会漏停，浏览器永远编码）')
  assert.equal(s2.streaming, false)

  await closeSession('k8')
})

test('W2.1 重建失败：旧帧订阅被清理，不挂成无主引用', async () => {
  __resetSessionForTest()
  const first = new ScreencastFakeDriver()
  let fail = false
  const factory = async (_o: DriverLaunchOptions): Promise<BrowserDebugDriver> => {
    if (fail) throw new Error('launch failed')
    return first
  }

  const s1 = await getOrCreateSession({ sessionKey: 'k9', headless: true, userDataDir: 'p', driverFactory: factory })
  await s1.subscribeFrames(() => {})
  assert.equal(s1.frames.subscriberCount, 1)

  first.alive = false
  fail = true
  await assert.rejects(
    () => getOrCreateSession({ sessionKey: 'k9', headless: true, userDataDir: 'p', driverFactory: factory }),
    /launch failed/,
  )
  assert.equal(s1.frames.subscriberCount, 0, '重建失败必须清理订阅，避免无主 stream 泄漏')

  __resetSessionForTest()
})
