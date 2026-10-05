import { randomUUID } from 'node:crypto'
import type { BrowserDebugDriver, BrowserInputEvent, ScreencastFrame, ScreencastOptions } from './driver.js'
import { BrowserInputState } from './input-state.js'
import { BrowserOperationError } from './operation-error.js'

/** Subscribers and the public sequence survive driver replacement. */
export class FrameStream {
  private subscribers = new Set<(frame: ScreencastFrame) => void>()
  private active = false
  private detached = false
  private sequence = 0
  private generation = 0
  private contextId = randomUUID()
  private lifecycle: Promise<unknown> = Promise.resolve()
  private unwatch?: () => void
  private input = new BrowserInputState()
  constructor(private driver: BrowserDebugDriver) { this.watch(driver) }
  get interactionId(): string { return this.contextId }
  get streaming(): boolean { return this.active }
  get subscriberCount(): number { return this.subscribers.size }

  assertInteraction(expected: unknown): void {
    if (expected === undefined) return // Legacy callers retain their wire contract.
    if (typeof expected !== 'string' || expected !== this.contextId || this.detached) {
      throw new BrowserOperationError('stale_context', 'Browser target changed; refresh the view before retrying')
    }
  }
  async dispatchInput(event: BrowserInputEvent, expected?: unknown): Promise<boolean> {
    if (this.driver.isAlive?.() === false) throw new BrowserOperationError('browser_disconnected', 'Browser driver disconnected')
    if (!this.driver.dispatchInput) return false
    this.assertInteraction(expected)
    const press = event.type === 'mousePressed' || event.type === 'keyDown'
    let checked = false
    await this.driver.dispatchInput(event, () => {
      this.assertInteraction(expected)
      checked = true
      if (press) this.input.record(event)
    })
    if (!checked || !press) this.input.record(event)
    return true
  }
  async releaseInput(): Promise<void> {
    const driver = this.driver
    await this.input.release(async event => {
      if (!driver.dispatchInput) throw new BrowserOperationError('capability_unsupported', 'Input release is unavailable')
      await driver.dispatchInput(event)
    })
  }
  private invalidate(): void { this.contextId = randomUUID(); this.generation++ }
  private watch(driver: BrowserDebugDriver): void {
    this.unwatch?.()
    this.unwatch = driver.subscribeTargetChanges?.(() => {
      if (driver !== this.driver) return
      this.invalidate()
      if (!this.detached) void this.refresh().catch(() => {})
    })
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.catch(() => {}).then(operation)
    this.lifecycle = next
    return next
  }
  private stamp(frame: ScreencastFrame | null, generation: number): ScreencastFrame | null {
    if (!frame || generation !== this.generation || this.detached ||
      !frame.data || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0) return null
    return { ...frame, seq: ++this.sequence, interactionId: this.contextId }
  }
  async captureFrame(opts?: ScreencastOptions): Promise<ScreencastFrame | null> {
    const generation = this.generation
    const driver = this.driver
    try { return this.stamp(await driver.captureFrame?.(opts) ?? null, generation) }
    catch { return null }
  }
  private broadcast(frame: ScreencastFrame): void {
    for (const cb of this.subscribers) { try { cb(frame) } catch { /* isolate consumers */ } }
  }
  private async stop(): Promise<void> {
    if (!this.active) return
    this.active = false
    await this.driver.stopScreencast?.().catch(() => {})
  }
  private async start(opts: ScreencastOptions = {}): Promise<void> {
    if (this.active || this.detached || !this.subscribers.size || !this.driver.startScreencast) return
    const generation = this.generation
    try {
      await this.driver.startScreencast(opts, frame => {
        const normalized = this.stamp(frame, generation)
        if (normalized) this.broadcast(normalized)
      })
      this.active = true
    } catch (error) { this.active = false; throw error }
  }
  async subscribe(onFrame: (frame: ScreencastFrame) => void, opts?: ScreencastOptions): Promise<() => void> {
    if (!this.driver.startScreencast) return () => {}
    this.subscribers.add(onFrame)
    try { await this.serialized(() => this.start(opts)) }
    catch (error) { this.subscribers.delete(onFrame); throw error }
    let done = false
    return () => {
      if (done) return
      done = true
      this.subscribers.delete(onFrame)
      if (!this.subscribers.size) void this.serialized(async () => {
        if (!this.subscribers.size) { this.generation++; await this.stop() }
      })
    }
  }
  async detach(): Promise<void> {
    this.detached = true
    this.invalidate()
    await this.serialized(() => this.stop())
  }
  async refresh(): Promise<void> {
    await this.serialized(async () => {
      if (this.detached) return
      await this.releaseInput()
      this.generation++
      await this.stop()
      await this.start()
      const frame = await this.captureFrame()
      if (frame) this.broadcast(frame)
    })
  }
  async changeInteraction(): Promise<void> {
    this.invalidate()
    await this.refresh()
  }
  async rebind(driver: BrowserDebugDriver): Promise<number> {
    this.invalidate()
    return this.serialized(async () => {
      this.invalidate()
      await this.stop()
      if (driver !== this.driver) this.input = new BrowserInputState()
      this.driver = driver
      this.watch(driver)
      this.detached = false
      try {
        await this.start()
        const frame = await this.captureFrame()
        if (frame) this.broadcast(frame)
        return this.active ? this.subscribers.size : 0
      } catch { this.active = false; return 0 }
    })
  }
  clear(): void {
    this.detached = true
    this.invalidate()
    this.subscribers.clear()
    this.unwatch?.()
    this.unwatch = undefined
    void this.serialized(() => this.stop())
  }
}
