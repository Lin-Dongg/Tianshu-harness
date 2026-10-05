/**
 * browser-debug/session — per-sessionKey persistent browser sessions.
 *
 * Desktop runs multiple agent sessions in parallel; each gets its own browser
 * instance keyed by params.sessionId (TUI falls back to __default__).
 */

import {
  LogCapture,
  normalizeConsoleLevel,
  formatConsoleLine,
  formatNetworkLine,
} from './log-capture.js'
import {
  defaultDriverFactory,
  type BrowserDebugDriver,
  type BrowserDebugDriverFactory,
  type BrowserInputEvent,
  type DriverEvents,
  type ScreencastFrame,
  type ScreencastOptions,
} from './driver.js'
import { FrameStream } from './frame-stream.js'

export const DEFAULT_SESSION_KEY = '__default__'

export type BrowserSessionMode = 'launch' | 'connect'

export interface OpenSessionOptions {
  sessionKey: string
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
  /** Initial page size. Omitted = the driver's default. */
  viewport?: { width: number; height: number }
  /** 重建时继承旧会话的日志缓冲（console/network 是已捕获的证据，不随会话对象销毁）。 */
  log?: LogCapture
  /** 重建交接：接管旧会话的帧流（订阅集合跨重建共享，面板无需重连）。 */
  frames?: FrameStream
}

export type OutputSink = (chunk: string) => void

export class BrowserDebugSession {
  readonly sessionKey: string
  readonly driver: BrowserDebugDriver
  readonly log: LogCapture
  readonly headless: boolean
  readonly mode: BrowserSessionMode
  readonly connectUrl?: string
  readonly userDataDir?: string
  /** 实时帧流中枢——跨会话重建共享（见 frame-stream.ts）。 */
  readonly frames: FrameStream
  private outputSink: OutputSink | null = null

  private constructor(
    sessionKey: string,
    driver: BrowserDebugDriver,
    headless: boolean,
    mode: BrowserSessionMode,
    meta: { connectUrl?: string; userDataDir?: string; log?: LogCapture; frames?: FrameStream },
  ) {
    this.sessionKey = sessionKey
    this.driver = driver
    this.log = meta.log ?? new LogCapture()
    this.frames = meta.frames ?? new FrameStream(driver)
    this.headless = headless
    this.mode = mode
    this.connectUrl = meta.connectUrl
    this.userDataDir = meta.userDataDir
  }

  /** 会话是否可用：driver 未实现存活判定时视为存活（测试桩/假 driver）。 */
  isAlive(): boolean {
    try {
      return this.driver.isAlive?.() ?? true
    } catch {
      return false
    }
  }

  setOutputSink(sink: OutputSink | null): void {
    this.outputSink = sink
  }

  private emit(line: string): void {
    try {
      this.outputSink?.(line.endsWith('\n') ? line : line + '\n')
    } catch {
      /* ignore */
    }
  }

  // ── 实时帧流（供内嵌浏览器视图订阅）────────────────────────────────────
  // 多订阅者共享**一条** screencast；引用计数归零即停播——面板关掉之后不该让
  // 浏览器继续无谓地编码帧。订阅集合在 FrameStream 里，跨会话重建共享。

  /** 订阅实时画面，返回幂等退订函数。driver 无帧流能力时返回 no-op 退订。 */
  async subscribeFrames(
    onFrame: (frame: ScreencastFrame) => void,
    opts?: ScreencastOptions,
  ): Promise<() => void> {
    return await this.frames.subscribe(onFrame, opts)
  }

  /** 是否正在推流。 */
  get streaming(): boolean {
    return this.frames.streaming
  }

  /** 取一张当前画面（连接瞬间补首帧，避免静态页黑屏）。无能力时返回 null。 */
  async captureFrame(opts?: ScreencastOptions): Promise<ScreencastFrame | null> {
    return await this.frames.captureFrame(opts)
  }

  /** 反向注入输入事件。返回是否被驱动接受（无能力时 false）。 */
  async dispatchInput(evt: BrowserInputEvent, expected?: unknown): Promise<boolean> {
    return await this.frames.dispatchInput(evt, expected)
  }

  static async open(opts: OpenSessionOptions): Promise<BrowserDebugSession> {
    const mode: BrowserSessionMode = opts.connectUrl ? 'connect' : 'launch'
    let self: BrowserDebugSession | null = null
    const events: DriverEvents = {
      onConsole: (rawLevel, text) => {
        const level = normalizeConsoleLevel(rawLevel)
        const entry = self!.log.addConsole(level, text)
        self!.emit(formatConsoleLine(entry))
      },
      onRequestStart: (id, method, url, resourceType, headers, postData) => {
        const entry = self!.log.startRequest(id, method, url, Date.now(), resourceType, headers, postData)
        self!.emit(formatNetworkLine(entry))
      },
      onResponse: (id, status, resourceType, headers) => {
        const entry = self!.log.completeRequest(id, status, Date.now(), resourceType, headers)
        self!.emit(formatNetworkLine(entry))
      },
      onRequestFailed: (id, method, url, errorText, resourceType) => {
        const entry = self!.log.failRequest(id, method, url, errorText, Date.now(), resourceType)
        self!.emit(formatNetworkLine(entry))
      },
      onResponseBody: (id, body, contentType) => {
        self!.log.attachResponseBody(id, body, contentType)
      },
    }
    const factory = opts.driverFactory ?? defaultDriverFactory
    const driver = await factory({
      headless: opts.headless,
      userDataDir: opts.userDataDir,
      connectUrl: opts.connectUrl,
      viewport: opts.viewport,
      events,
    })
    // 重建交接：旧订阅集合挂到新 driver 上（重启推流 + 补一帧，面板无感）。
    // 必须在构造 self 之前完成——rebind 的补帧回调直接走订阅者，不依赖 self。
    if (opts.frames) await opts.frames.rebind(driver)
    self = new BrowserDebugSession(opts.sessionKey, driver, opts.headless, mode, {
      connectUrl: opts.connectUrl,
      userDataDir: mode === 'launch' ? opts.userDataDir : undefined,
      log: opts.log,
      frames: opts.frames,
    })
    return self
  }

  async close(): Promise<void> {
    try {
      await this.driver.close()
    } catch {
      /* 半死浏览器（CDP 已断/进程已退出）的 close 可能抛——close 是清理语义，
         不能被它挡住：否则最需要 close 的时候反而关不掉会话。 */
    } finally {
      this.log.clear()
      this.outputSink = null
      // 关会话即断流：停推流并清空订阅者，否则复用的 sessionKey 会误判
      // 「已经在推流」而不再启动 screencast。
      await this.frames.detach().catch(() => {})
      this.frames.clear()
    }
  }

  /**
   * 驱逐重建前退役：尽力关闭底层 driver，但**保留 log 与帧订阅者**——
   * 日志交给新会话继承，订阅者交给新会话的 FrameStream 接管（W2.1）。
   * 与 close() 的差别只有「日志/订阅清不清」。
   */
  async retireForRebuild(): Promise<void> {
    try {
      await this.driver.close()
    } catch {
      /* 浏览器可能已经死了——退役是清理语义，不因此失败 */
    }
    this.outputSink = null
    // 停旧 driver 的推流但保留订阅者；重建失败时由 getOrCreateSession 兜底 clear()。
    await this.frames.detach()
  }
}

const sessions = new Map<string, BrowserDebugSession>()
const opening = new Map<string, Promise<BrowserDebugSession>>()
/**
 * 每个 sessionKey 的世代号：closeSession/驱逐会 +1，让在途的 opening 在完成时
 * 发现自己已过期而不再写回 Map（否则会留下关不掉的僵尸会话）。
 */
const generations = new Map<string, number>()
let exitHookInstalled = false

function currentGeneration(key: string): number {
  return generations.get(key) ?? 0
}

function bumpGeneration(key: string): void {
  generations.set(key, currentGeneration(key) + 1)
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    for (const s of sessions.values()) {
      void s.close().catch(() => {})
    }
    sessions.clear()
    opening.clear()
  }
  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
}

export function resolveSessionKey(sessionId?: string): string {
  return sessionId?.trim() ? sessionId.trim() : DEFAULT_SESSION_KEY
}

export async function getOrCreateSession(opts: {
  sessionKey: string
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
  viewport?: { width: number; height: number }
  /** 重建时继承的日志缓冲；缺省时若驱逐了旧会话则自动继承它的 log。 */
  log?: LogCapture
  /** 已被调用方驱逐的旧会话（工具侧强制重建路径）——用于交接帧订阅集合。 */
  handoffFrom?: BrowserDebugSession
}): Promise<BrowserDebugSession> {
  const key = opts.sessionKey
  const existing = sessions.get(key)
  if (existing && existing.isAlive()) return existing

  let carryLog = opts.log
  let handoff = opts.handoffFrom
  if (existing) {
    // 死会话：驱逐（保留日志与帧订阅者），下一次 open 用新 driver 重建。
    const retired = await evictSession(key, existing)
    carryLog = carryLog ?? existing.log
    handoff = handoff ?? retired ?? undefined
  }

  const inflight = opening.get(key)
  if (inflight) return inflight

  installExitHook()
  const gen = currentGeneration(key)
  const promise = BrowserDebugSession.open({
    sessionKey: key,
    headless: opts.headless,
    userDataDir: opts.userDataDir,
    connectUrl: opts.connectUrl,
    driverFactory: opts.driverFactory,
    viewport: opts.viewport,
    log: carryLog,
    frames: handoff?.frames,
  })
    .then((s) => {
      if (opening.get(key) === promise) opening.delete(key)
      if (currentGeneration(key) !== gen) {
        // 开门期间被 closeSession/驱逐：不要把过期会话写回 Map。
        // 订阅者无处迁移，清掉避免挂在无主 stream 上。
        handoff?.frames.clear()
        void s.close()
        return s
      }
      sessions.set(key, s)
      return s
    })
    .catch((err) => {
      if (opening.get(key) === promise) opening.delete(key)
      // 重建失败：面板保持冻结（浏览器本来也死了），但不能把订阅者挂成无主引用。
      handoff?.frames.clear()
      throw err
    })
  opening.set(key, promise)
  return promise
}

/**
 * 驱逐一个已失效/待重建的会话（getOrCreateSession 与工具侧死亡恢复共用）。
 * 只有 Map 里的实例仍是 expected 时才删（防止误删并发重建的新实例）。
 * 返回被驱逐的会话（供调用方交接帧订阅集合），没有驱逐时返回 null。
 */
export async function evictSession(sessionKey: string, expected?: BrowserDebugSession): Promise<BrowserDebugSession | null> {
  const cur = sessions.get(sessionKey)
  if (!cur || (expected && cur !== expected)) return null
  sessions.delete(sessionKey)
  opening.delete(sessionKey)
  bumpGeneration(sessionKey)
  await cur.retireForRebuild()
  return cur
}

export function getSession(sessionKey: string = DEFAULT_SESSION_KEY): BrowserDebugSession | null {
  return sessions.get(sessionKey) ?? null
}

/** 当前活跃会话的 sessionKey 列表——供实时视图列举「可以看哪个浏览器」。 */
export function listSessionKeys(): string[] {
  return [...sessions.keys()]
}

export async function closeSession(sessionKey: string = DEFAULT_SESSION_KEY): Promise<void> {
  const s = sessions.get(sessionKey)
  sessions.delete(sessionKey)
  opening.delete(sessionKey)
  bumpGeneration(sessionKey)
  if (s) await s.close()
}

/** Test hook: drop all sessions without touching real browsers. */
export function __resetSessionForTest(): void {
  sessions.clear()
  opening.clear()
  generations.clear()
}

/** Test hook: count open sessions. */
export function __sessionCountForTest(): number {
  return sessions.size
}
