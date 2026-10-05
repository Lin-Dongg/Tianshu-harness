import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { FrameStream } from '../frame-stream.js'
import { BrowserInputState, validateBrowserInput } from '../input-state.js'
import { browserOperation, browserOwner, setBrowserOwner, takeBrowserControl } from '../control.js'
import { browserErrorResponse } from '../operation-error.js'
import { getOrCreateSession, closeSession } from '../session.js'
import { buildBrowserRoutes } from '../../../server/browser-routes.js'
import { buildSessionBrowserRoutes } from '../../../server/session-browser.js'
import { createRouter } from '../../../server/index.js'
import type { BrowserDebugDriver, ScreencastFrame } from '../driver.js'
import type { RuntimeSessionManager } from '../../../server/session-manager.js'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function driver() {
  let sink: (f: ScreencastFrame) => void = () => {}, notify = () => {}
  const events: unknown[] = []
  let fail = false
  const fake = {
    isAlive: () => true, viewportSize: () => ({ width: 800, height: 600 }), currentUrl: () => 'about:blank', pageUrls: () => [], close: async () => {},
    startScreencast: async (_opts: unknown, cb: typeof sink) => { sink = cb }, stopScreencast: async () => {},
    captureFrame: async () => ({ data: 'x', width: 800, height: 600, seq: 1 }),
    subscribeTargetChanges: (cb: () => void) => { notify = cb; return () => { notify = () => {} } },
    dispatchInput: async (event: unknown) => { if (fail) throw Error('Session closed'); events.push(event) },
  } as unknown as BrowserDebugDriver
  return { fake, events, callback: () => sink, notify: () => notify(), fail: (value: boolean) => { fail = value } }
}
test('public sequence survives raw 100 → 1, snapshot and obsolete callback', async () => {
  const first = driver(), next = driver(), stream = new FrameStream(first.fake)
  const frames: ScreencastFrame[] = []
  const unsubscribe = await stream.subscribe(frame => frames.push(frame))
  const old = first.callback()
  old({ data: 'old', width: 800, height: 600, seq: 100 })
  const id = stream.interactionId
  await stream.rebind(next.fake)
  old({ data: 'obsolete', width: 800, height: 600, seq: 101 })
  next.callback()({ data: 'new', width: 800, height: 600, seq: 1 })
  const snapshot = await stream.captureFrame()
  assert.deepEqual(frames.map(frame => frame.seq), [1, 2, 3])
  assert.equal(snapshot?.seq, 4)
  assert.notEqual(stream.interactionId, id)
  assert.equal(frames[2]?.interactionId, stream.interactionId)
  unsubscribe(); await tick()
})
test('target change invalidates immediately and publishes a fresh snapshot', async () => {
  const d = driver(), stream = new FrameStream(d.fake), frames: ScreencastFrame[] = []
  const unsubscribe = await stream.subscribe(frame => frames.push(frame)), id = stream.interactionId
  d.notify()
  assert.throws(() => stream.assertInteraction(id), /target changed/)
  await tick()
  assert.equal(frames.at(-1)?.interactionId, stream.interactionId)
  unsubscribe(); await tick()
})
test('handoff drains active operation, releases held input, and failed release preserves owner', async () => {
  const key = randomUUID(), d = driver(), stream = new FrameStream(d.fake)
  setBrowserOwner(key, 'user')
  await stream.dispatchInput({ type: 'mousePressed', button: 'left', buttons: 1, x: 10, y: 20 })
  await stream.dispatchInput({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft' })
  let resolve!: () => void
  const inFlight = browserOperation(key, 'user', () => new Promise<void>(done => { resolve = done }))
  await tick()
  d.fail(true)
  const transfer = takeBrowserControl(key, 'agent', { beforeChange: () => stream.releaseInput() })
  await assert.rejects(browserOperation(key, 'user', async () => {}), /control/)
  assert.equal(browserOwner(key), 'user')
  resolve(); await inFlight
  await assert.rejects(transfer, /Session closed/)
  assert.equal(browserOwner(key), 'user')
  d.fail(false)
  await takeBrowserControl(key, 'agent', { beforeChange: () => stream.releaseInput() })
  assert.equal(browserOwner(key), 'agent')
  assert.deepEqual(d.events.slice(2).map(event => (event as { type: string }).type), ['mouseReleased', 'keyUp'])
})
test('queued input validates execution-time context; valid buttons pass, bad input and driver errors differ', async () => {
  const key = randomUUID(), d = driver(), stream = new FrameStream(d.fake)
  setBrowserOwner(key, 'user')
  const router = createRouter(buildBrowserRoutes('test', { getSession: () => ({ frames: stream, dispatchInput: (event: never) => stream.dispatchInput(event) }) as never }))
  const call = (body: unknown) => router('POST', '/browser/input', body, { authorization: 'Bearer test' })
  const id = stream.interactionId
  let done!: () => void
  const barrier = browserOperation(key, 'user', () => new Promise<void>(resolve => { done = resolve }))
  await tick()
  const queued = call({ sessionKey: key, expectedInteractionId: id, event: { type: 'mousePressed', x: 1, y: 2 } })
  await stream.changeInteraction(); done(); await barrier
  const stale = await queued
  assert.equal(stale.status, 409); assert.equal((stale.body as { code: string }).code, 'stale_context')
  assert.equal(d.events.length, 0)
  const body = { sessionKey: key, expectedInteractionId: stream.interactionId, event: { type: 'mouseMoved', x: 1, y: 2, buttons: 3 } }
  assert.equal((await call(body)).status, 200)
  assert.equal((d.events[0] as { buttons: number }).buttons, 3)
  assert.equal((await call({ ...body, event: { ...body.event, buttons: 32 } })).status, 400)
  d.fail(true)
  const failed = await call(body)
  assert.equal(failed.status, 503); assert.equal((failed.body as { code: string }).code, 'browser_disconnected')
})
test('text and navigation route fencing rejects stale document; same viewport keeps context', async () => {
  const key = randomUUID(), d = driver(), writes: string[] = []
  d.fake.insertText = async text => { writes.push(text) }
  d.fake.setViewport = async () => { throw Error('unchanged viewport must not resize') }
  d.fake.listPages = async () => []
  const session = await getOrCreateSession({ sessionKey: key, headless: true, userDataDir: tmpdir(), driverFactory: async () => d.fake })
  setBrowserOwner(key, 'user')
  const manager = { getSession: () => ({ id: key, cwd: tmpdir() }) } as unknown as RuntimeSessionManager
  const router = createRouter(buildSessionBrowserRoutes(manager, 'test'))
  const call = (body: unknown) => router('POST', `/sessions/${key}/browser`, body, { authorization: 'Bearer test' })
  try {
    const old = session.frames.interactionId
    await session.frames.changeInteraction()
    assert.equal((await call({ action: 'text', text: 'wrong page', expectedInteractionId: old })).status, 409)
    assert.deepEqual(writes, [])
    const id = session.frames.interactionId
    assert.equal((await call({ action: 'viewport', width: 800, height: 600, expectedInteractionId: id })).status, 200)
    assert.equal(session.frames.interactionId, id)
    assert.equal((await call({ action: 'text', text: '中文', expectedInteractionId: id })).status, 200)
    assert.deepEqual(writes, ['中文'])
  } finally { await closeSession(key) }
})
test('input validation rejects malformed finite fields and release does not insert text', async () => {
  assert.throws(() => validateBrowserInput({ type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: Infinity }))
  const state = new BrowserInputState(), events: unknown[] = []
  state.record({ type: 'keyDown', key: 'x', code: 'KeyX', text: 'x' })
  await state.release(async event => { events.push(event) })
  assert.equal('text' in (events[0] as object), false)
  assert.equal((events[0] as { type: string }).type, 'keyUp')
  assert.equal(browserErrorResponse(Error('arbitrary failure')).body.code, 'operation_failed')
})

test('a failed release still attempts the remaining held inputs and converges on retry', async () => {
  const state = new BrowserInputState()
  const sent: string[] = []
  state.record({ type: 'mousePressed', button: 'left', x: 1, y: 1 })
  state.record({ type: 'mousePressed', button: 'right', x: 1, y: 1 })
  let failOnce = true
  // 一项送失败不得跳过其余项——否则「右键从未被尝试释放」。
  await assert.rejects(state.release(async (event) => {
    sent.push(`${event.type}:${event.button}`)
    if (failOnce) { failOnce = false; throw Error('transient') }
  }))
  assert.deepEqual(sent, ['mouseReleased:left', 'mouseReleased:right'])
  // 送达的项已清账，重试只补未送达的那一项。
  const retry: string[] = []
  await state.release(async (event) => { retry.push(`${event.type}:${event.button}`) })
  assert.deepEqual(retry, ['mouseReleased:left'])
})

test('overlapping driver rebinds reject the intermediate callback too', async () => {
  const first = driver(), intermediate = driver(), last = driver(), stream = new FrameStream(first.fake)
  const frames: ScreencastFrame[] = []
  const unsubscribe = await stream.subscribe(frame => frames.push(frame))
  const one = stream.rebind(intermediate.fake), two = stream.rebind(last.fake)
  await one; await two
  intermediate.callback()({ data: 'obsolete', width: 800, height: 600, seq: 200 })
  last.callback()({ data: 'latest', width: 800, height: 600, seq: 1 })
  assert.equal(frames.some(frame => frame.data === 'obsolete'), false)
  assert.equal(frames.at(-1)?.data, 'latest')
  unsubscribe(); await tick()
})
test('context guard is passed to the driver at the actual CDP send boundary', async () => {
  const d = driver(), stream = new FrameStream(d.fake), id = stream.interactionId
  d.fake.dispatchInput = async (event, check) => { if (event.type === 'keyUp') return; await stream.changeInteraction(); check?.(); d.events.push('wrong document') }
  await assert.rejects(stream.dispatchInput({ type: 'keyDown', key: 'Enter' }, id), /target changed/)
  assert.deepEqual(d.events, [])
})

test('stale CDP binding never emits a release into the replacement context', async () => {
  const d = driver(), stream = new FrameStream(d.fake), id = stream.interactionId
  d.fake.dispatchInput = async (event, check) => {
    if (event.type === 'keyUp') { d.events.push(event); return }
    await stream.changeInteraction()
    check?.()
  }
  await assert.rejects(stream.dispatchInput({ type: 'keyDown', key: 'Enter', code: 'Enter' }, id), /target changed/)
  assert.deepEqual(d.events, [], 'a rejected press must not create a release on the new document')
})

test('frames dropped for invalid data or dimensions are counted instead of vanishing silently', async () => {
  const d = driver(), stream = new FrameStream(d.fake), frames: ScreencastFrame[] = []
  const unsubscribe = await stream.subscribe(frame => frames.push(frame))
  const sink = d.callback()
  sink({ data: 'bad', width: 0, height: 600, seq: 1 })
  sink({ data: 'bad', width: 800, height: 0, seq: 2 })
  sink({ data: '', width: 800, height: 600, seq: 3 })
  assert.equal(stream.droppedFrames, 3, 'unusable frames must be observable, not silent')
  sink({ data: 'good', width: 800, height: 600, seq: 4 })
  assert.equal(stream.droppedFrames, 3, 'a valid frame is not a drop')
  assert.equal(frames.at(-1)?.data, 'good')
  // 过期帧（失效/背压）是正常路径，不计入丢弃。
  const stale = d.callback()
  await stream.changeInteraction()
  stale({ data: 'stale', width: 800, height: 600, seq: 9 })
  assert.equal(stream.droppedFrames, 3, 'stale frames are expected backpressure, not drops')
  unsubscribe(); await tick()
})
