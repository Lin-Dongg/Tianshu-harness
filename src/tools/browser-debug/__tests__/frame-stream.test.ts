/**
 * FrameStream 反证测试（W2.1）：订阅集合跨 driver 重建共享，
 * 退订永远打在「当前接管者」上——旧实现会退订旧会话、把新会话订阅漏成永久推流。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameStream } from '../frame-stream.js'
import type { ScreencastFrame, ScreencastOptions } from '../driver.js'

class StreamDriver {
  startCount = 0
  stopCount = 0
  sink: ((frame: ScreencastFrame) => void) | null = null
  captureSeq = 99
  failStart = false
  async startScreencast(_opts: ScreencastOptions, onFrame: (f: ScreencastFrame) => void): Promise<void> {
    this.startCount += 1
    if (this.failStart) throw new Error('startScreencast failed')
    this.sink = onFrame
  }
  async stopScreencast(): Promise<void> {
    this.stopCount += 1
    this.sink = null
  }
  async captureFrame(): Promise<ScreencastFrame> {
    return { data: 'INIT', width: 1, height: 1, seq: this.captureSeq }
  }
  emit(seq: number): void {
    this.sink?.({ data: 'x', width: 1, height: 1, seq })
  }
}

const asDriver = (d: unknown) => d as never

test('引用计数：首个订阅启动，多订阅者共享一条流，最后退订才停', async () => {
  const driver = new StreamDriver()
  const stream = new FrameStream(asDriver(driver))
  const a: number[] = []
  const b: number[] = []

  const unsubA = await stream.subscribe((f) => { a.push(f.seq) })
  assert.equal(driver.startCount, 1)
  assert.equal(stream.streaming, true)

  const unsubB = await stream.subscribe((f) => { b.push(f.seq) })
  assert.equal(driver.startCount, 1, '第二个订阅者必须复用同一条 screencast')

  driver.emit(1)
  assert.deepEqual(a, [1])
  assert.deepEqual(b, [1])

  unsubA()
  assert.equal(driver.stopCount, 0, '仍有订阅者时不得停播')
  unsubB()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(driver.stopCount, 1)
  assert.equal(stream.streaming, false)
})

test('退订幂等：重复调用不会多停一次', async () => {
  const driver = new StreamDriver()
  const stream = new FrameStream(asDriver(driver))
  const unsub = await stream.subscribe(() => {})
  unsub()
  unsub()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(driver.stopCount, 1)
})

test('W2.1 rebind：订阅迁移到新 driver、补一帧、退订停新 driver', async () => {
  const first = new StreamDriver()
  const second = new StreamDriver()
  const stream = new FrameStream(asDriver(first))
  const got: number[] = []
  const unsubA = await stream.subscribe((f) => { got.push(f.seq) })
  const unsubB = await stream.subscribe(() => {})

  await stream.detach()
  assert.equal(first.stopCount, 1, '退役旧 driver 时停播')
  assert.equal(stream.streaming, false)
  assert.equal(stream.subscriberCount, 2, '退役必须保留订阅者，等新会话接管')

  const adopted = await stream.rebind(asDriver(second))
  assert.equal(adopted, 2)
  assert.equal(second.startCount, 1, '接管时必须在新 driver 上重启推流')
  assert.deepEqual(got, [1], '接管时补一帧（静态页不会自己产帧）')

  second.emit(7)
  assert.deepEqual(got, [1, 2])

  unsubA()
  assert.equal(second.stopCount, 0, '还有订阅者时不停播')
  unsubB()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.stopCount, 1, '退订必须停在新 driver 上——旧实现会漏停')
  assert.equal(stream.streaming, false)
})

test('rebind：没有订阅者时不启动推流', async () => {
  const first = new StreamDriver()
  const second = new StreamDriver()
  const stream = new FrameStream(asDriver(first))
  const adopted = await stream.rebind(asDriver(second))
  assert.equal(adopted, 0)
  assert.equal(second.startCount, 0)
  assert.equal(stream.streaming, false)
})

test('无帧流能力的 driver：订阅是 no-op，不抛且不进入推流态', async () => {
  const stream = new FrameStream(asDriver({}))
  const unsub = await stream.subscribe(() => {})
  assert.equal(stream.streaming, false)
  assert.equal(stream.subscriberCount, 0, '无能力时不应登记订阅者')
  unsub()
  assert.equal(await stream.rebind(asDriver({})), 0)
})

test('rebind 到无能力 driver：订阅保留，不崩；后续接回有能力的 driver 仍可服务', async () => {
  const first = new StreamDriver()
  const stream = new FrameStream(asDriver(first))
  const got: number[] = []
  await stream.subscribe((f) => { got.push(f.seq) })
  await stream.detach()

  assert.equal(await stream.rebind(asDriver({})), 0, '无能力接管返回 0，不抛')
  assert.equal(stream.subscriberCount, 1, '订阅保留，等待下一次接管')

  const third = new StreamDriver()
  assert.equal(await stream.rebind(asDriver(third)), 1)
  assert.equal(third.startCount, 1)
  third.emit(3)
  assert.deepEqual(got, [1, 2])
})

test('rebind 启动失败：不留下「正在推流」的假状态', async () => {
  const first = new StreamDriver()
  const second = new StreamDriver()
  second.failStart = true
  const stream = new FrameStream(asDriver(first))
  await stream.subscribe(() => {})
  await stream.detach()

  assert.equal(await stream.rebind(asDriver(second)), 0)
  assert.equal(stream.streaming, false)
  assert.equal(stream.subscriberCount, 1, '失败不清订阅者——可等下一次重建再试')
})
