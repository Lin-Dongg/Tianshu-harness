/**
 * Event-loop liveness signal (Phase 2 of the desktop reliability plan).
 *
 * The sidecar serves HTTP/SSE and runs the agent loop in ONE Node process, so
 * a long synchronous stretch (sync IO, big JSON.parse, inline diff fallback)
 * starves the SSE keepalive and /health at the same time — the client then
 * sees a "connection interrupted" it can't tell apart from a real network
 * drop. Publishing the measured loop delay on /health lets the UI (and the
 * Rust supervisor later) label that state honestly: "service busy", not
 * "disconnected".
 *
 * Samples once per second. Readers share a non-destructive 30 second window.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { getRecentActivities, type RecentActivity } from '../agent/stall-observer.js'

export interface LoopLagSnapshot {
  /** p99 event-loop delay in ms over the window since the last snapshot. */
  sampledAt?: number
  p99Ms: number
  /** Worst single delay in ms over the same window. */
  maxMs: number
}

const NS_PER_MS = 1e6

export class LoopHealthMonitor {
  // 20ms resolution keeps sampling overhead negligible (<0.1% CPU) while still
  // resolving the multi-hundred-ms stalls we care about.
  private hist = monitorEventLoopDelay({ resolution: 20 })
  private started = false
  private timer?: ReturnType<typeof setInterval>
  private samples: Array<LoopLagSnapshot & { sampledAt: number }> = []

  start(): void {
    if (this.started) return
    this.hist.enable()
    this.started = true
    this.timer = setInterval(() => this.sample(), 1000)
    this.timer.unref()
  }

  stop(): void {
    if (!this.started) return
    clearInterval(this.timer)
    this.hist.disable()
    this.started = false
  }

  private sample(): void {
    const sampledAt = Date.now()
    const ms = (value: number) => Number.isFinite(value) ? Math.round(value / NS_PER_MS * 10) / 10 : 0
    this.samples.push({ sampledAt, p99Ms: ms(this.hist.percentile(99)), maxMs: ms(this.hist.max) })
    this.hist.reset()
    this.samples = this.samples.filter(sample => sample.sampledAt >= sampledAt - 30_000)
  }

  /** Conservative maximum of one-second p99 samples, not a pooled percentile. */
  snapshot(): LoopLagSnapshot {
    const samples = this.samples.filter(sample => sample.sampledAt >= Date.now() - 30_000)
    return {
      sampledAt: samples.at(-1)?.sampledAt ?? 0,
      p99Ms: Math.max(0, ...samples.map(sample => sample.p99Ms)),
      maxMs: Math.max(0, ...samples.map(sample => sample.maxMs)),
    }
  }
}

/**
 * 事件循环卡顿归因（漂移检测）。
 *
 * 与 LoopHealthMonitor 的分工：后者是「拉」——1s 采样、30s 窗口，/health 读快照，
 * 回答「服务忙不忙」；本类是「推」——250ms 定时器量**实际间隔**（漂移），超过
 * 阈值即推一条结构化卡顿事件。卡顿归因需要的正是「哪一次卡顿、多久、卡顿前在
 * 跑什么」，这是窗口快照给不出的。
 *
 * 为什么不用窗口最大值：现有 [loop-lag]（serve.ts 的 loopLagForHealth）按 30s
 * 窗口 max 打印，同一尖峰会在多个采样里重复打印，且尖峰只在**卡顿结束后**的
 * 采样里可见——12–19s 的阻塞恢复后只留下一行无归属的 max。漂移检测在恢复后的
 * **第一个晚到 tick** 上就算出 gap，并借 stall-observer 的环形缓冲指认「卡顿
 * 开始前 1 秒内碰过的活动」。
 *
 * 去重语义：进入「卡顿中」状态后不再重复打印，直到某个正常间隔的 tick 出现
 * （即恢复）才解锁——一次卡顿一条，但不漏掉下一次卡顿。完全卡死时本检测器同样
 * 被推迟，但它算的是**已发生的**间隔，恢复后立刻补报。
 *
 * 不在此处接线 serve.ts：本类只提供可注入的 warn/onStall 接口，替换旧
 * [loop-lag] 打印属后续波次。
 */
export interface LoopStallEvent {
  /** 卡顿开始时刻（上一个正常 tick 的实际时刻，epoch ms）——归因窗口右界。 */
  startedAt: number
  /** 观测到的卡顿时长 ms（相邻两次 tick 的实际间隔，含预期的采样间隔）。 */
  stalledMs: number
  /** 判定阈值 ms（同 options.stallThresholdMs）。 */
  thresholdMs: number
  /** 事件循环冻结时观测到的堆用量（MB）。 */
  heapUsedMb: number
  /** 事件循环冻结时观测到的常驻内存（MB）。 */
  rssMb: number
  /** 卡顿开始前 attributionWindowMs 内碰过的活动（stall-observer 环形缓冲）。 */
  recentActivities: RecentActivity[]
}

export interface LoopStallDetectorOptions {
  /** 采样间隔 ms（默认 250）。 */
  intervalMs?: number
  /** 判定为卡顿的间隔阈值 ms（默认 2000）。 */
  stallThresholdMs?: number
  /** 归因窗口 ms（默认 1000）——取卡顿开始前这么久内碰过的活动。 */
  attributionWindowMs?: number
  /** 卡顿日志输出（默认 console.warn）。 */
  warn?: (message: string) => void
  /** 结构化卡顿事件回调——serve.ts 后续接线用。 */
  onStall?: (event: LoopStallEvent) => void
  /** 可注入时钟（测试用），默认 Date.now。 */
  now?: () => number
  /** 活动来源查询（默认真实环形缓冲），可注入。 */
  queryActivities?: (lookbackMs: number, anchorMs?: number) => RecentActivity[]
  /** 内存快照（默认 process.memoryUsage），可注入。 */
  memoryUsage?: () => { heapUsed: number; rss: number }
}

const BYTES_PER_MB = 1048576

export class LoopStallDetector {
  private readonly intervalMs: number
  private readonly thresholdMs: number
  private readonly attributionWindowMs: number
  private readonly warnFn: (message: string) => void
  private readonly onStall?: (event: LoopStallEvent) => void
  private readonly now: () => number
  private readonly queryActivities: (lookbackMs: number, anchorMs?: number) => RecentActivity[]
  private readonly memoryUsage: () => { heapUsed: number; rss: number }

  private timer?: ReturnType<typeof setInterval>
  private lastTickAt?: number
  private inStall = false
  private started = false

  constructor(options: LoopStallDetectorOptions = {}) {
    this.intervalMs = options.intervalMs ?? 250
    this.thresholdMs = options.stallThresholdMs ?? 2000
    this.attributionWindowMs = options.attributionWindowMs ?? 1000
    this.warnFn = options.warn ?? ((message: string) => console.warn(message))
    this.onStall = options.onStall
    this.now = options.now ?? (() => Date.now())
    this.queryActivities = options.queryActivities ?? getRecentActivities
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.lastTickAt = this.now()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.started) return
    clearInterval(this.timer)
    this.timer = undefined
    this.started = false
    this.inStall = false
    this.lastTickAt = undefined
  }

  /** 当前是否处于「卡顿中」状态（诊断/测试用）。 */
  isStalled(): boolean {
    return this.inStall
  }

  private tick(): void {
    const now = this.now()
    const previous = this.lastTickAt ?? now
    this.lastTickAt = now
    const gap = now - previous

    if (gap <= this.thresholdMs) {
      // 正常间隔 = 已恢复：解锁，下一次卡顿可以再记一条。
      this.inStall = false
      return
    }
    if (this.inStall) return // 同一次卡顿只记一条

    this.inStall = true
    const mem = this.memoryUsage()
    const recentActivities = this.queryActivities(this.attributionWindowMs, previous)
    const event: LoopStallEvent = {
      startedAt: previous,
      stalledMs: gap,
      thresholdMs: this.thresholdMs,
      heapUsedMb: Math.round(mem.heapUsed / BYTES_PER_MB),
      rssMb: Math.round(mem.rss / BYTES_PER_MB),
      recentActivities,
    }
    this.warnFn(
      `[loop-stall] t=${new Date(now).toISOString()} startedAt=${new Date(previous).toISOString()}`
      + ` stalled=${event.stalledMs}ms threshold=${event.thresholdMs}ms`
      + ` heapUsed=${event.heapUsedMb}MB rss=${event.rssMb}MB`
      + ` activities=${formatStallActivities(recentActivities, previous)}`,
    )
    this.onStall?.(event)
  }
}

/** 归因摘要：`key:source@-Nms`（N = 距卡顿开始多久），无活动记 'none'。 */
function formatStallActivities(activities: RecentActivity[], anchorMs: number): string {
  if (activities.length === 0) return 'none'
  return activities
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((a) => `${a.key}:${a.source}@-${Math.max(0, anchorMs - a.ts)}ms`)
    .join(',')
}
