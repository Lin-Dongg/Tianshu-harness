/**
 * Store Lock — 会话库单写者独占锁（P0-1）
 *
 * 为什么需要它：多个 sidecar 进程（tauri dev、测试脚本、VSCode 插件）共用
 * 同一个桌面会话库（desktopDir()）时，每个进程启动都会跑 rehydrate()，把别人
 * 正在跑的会话标成『已中断』并写入 seq 高出 CRASH_RECOVERY_SEQ_GAP（100_000）
 * 的假中断标记；desktop 端 event-reducer 的 `ev.seq <= state.lastSeq` 守卫随后
 * 丢弃假标记之后的**全部真实输出**——即『假续跑』。会话库必须单写者：
 * 拿不到锁的进程不碰会话库（后续波次在 serve.ts 接线时拒绝启动并显示横幅）。
 *
 * 与 CronLock 的关系：同一套 PID 租约锁机制（O_EXCL 原子创建 + hard-link 发布、
 * 存活探测、串行 reclaim），底层原语直接复用 src/server/cron-lock.ts 的导出，
 * 不复制实现。差异（本模块扩展的部分）：
 *   1. 有界重试 acquire（默认 5s 窗口）——覆盖监管器『杀旧进程 → 拉起新进程』的交接；
 *   2. 两条额外陈旧判据：持有者启动时间早于本次开机（重启后 PID 复用）、
 *      锁文件心跳超过 10 分钟未刷新；
 *   3. 心跳只刷新 mtime（utimesSync），**绝不重写锁文件内容**——writeFileSync 会
 *      先截断文件，并发读者可能读到半写 JSON 而误判『锁损坏』去抢锁（split-brain）；
 *   4. node:test 护栏：测试进程持默认真实目录锁路径时直接拒绝，防测试污染真实会话库；
 *   5. 升级过渡期判据：不认识 sidecar.lock 的旧版 sidecar 仍在写会话库时，它必然持有同目录的
 *      定时任务锁（scheduled_tasks.lock）——持有者是别的活进程就按占用处理（见 legacyWriter）。
 *
 * 失效方向（硬约束）：误判『仍被占用』= 拒绝启动 + 横幅（可恢复）；
 * 误判『已失效』= 两个进程同写会话库（数据损坏）。所有模糊情形一律偏向『占用』：
 *   - boot time 取不到 → 该判据不生效；
 *   - 跨主机锁 → 视为占用（本机 PID 判不了远端进程死活）；
 *   - 心跳 > 10 分钟才判死（实测最长卡顿 19s，监管器强杀上限 180s，余量充足）。
 */

import { existsSync, readFileSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname as osHostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread } from 'node:worker_threads'
import { desktopDir, defaultRivetHome } from '../config/paths.js'
import {
  createLockFileExclusive,
  isPidAlive,
  readLockFile,
  type LockInfo,
} from './cron-lock.js'

export type { LockInfo }

// ─── Constants ────────────────────────────────────────────────

/** 锁文件名（位于 desktopDir() 下）。 */
export const STORE_LOCK_FILENAME = 'sidecar.lock'

/** 同目录的定时任务锁（serve.ts 的 CronLock）：升级过渡期判据读它认出旧版写者。 */
export const LEGACY_WRITER_LOCK_FILENAME = 'scheduled_tasks.lock'

/** acquire 默认重试窗口（毫秒）：覆盖监管器杀旧进程 → 拉起新进程的交接窗口。 */
export const DEFAULT_ACQUIRE_WINDOW_MS = 5_000

/** acquire 重试间隔（毫秒）。 */
export const DEFAULT_ACQUIRE_INTERVAL_MS = 250

/** 持有者刷新锁文件心跳的间隔（毫秒）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

/** 心跳超过该时长未刷新即判为陈旧（毫秒）。 */
export const STORE_LOCK_HEARTBEAT_STALE_MS = 10 * 60_000

/**
 * 启动时间与开机时间的比较容差（毫秒）。判据方向是『记录启动时间早于开机』——
 * 容差让判据**更难**成立（宁可判占用也不误抢），覆盖时钟抖动/boottime 精度差。
 */
const BOOT_TIME_SKEW_GRACE_MS = 5_000

/**
 * 锁里记录的启动时间与该 PID 真实启动时间（ps，秒级）允许的偏差。超出 = PID 已被复用。
 * 记录值取自 owner 进程内的 `Date.now() - uptime`，与 ps 的差实测在 1s 量级。
 */
const PROCESS_START_MATCH_TOLERANCE_MS = 30_000

const PROCESS_OWNER_TOKEN = randomUUID()
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1000)

// ─── Types ────────────────────────────────────────────────────

/** 占用者摘要：调用方拿它在横幅/health 里说明『谁占着会话库』。 */
export interface StoreLockHolder {
  pid: number
  startedAtMs?: number
  hostname?: string
}

/** 未获得锁的原因（供横幅文案/健康上报区分场景）。 */
export type LockContentionReason =
  | 'pid_alive'          // 持有者进程存活且心跳新鲜
  | 'cross_host'         // 锁来自另一台主机，本机 PID 判不了死活 → 保守占用
  | 'reclaim_in_progress' // 陈旧锁回收被别的进程抢占（reclaim 锁竞争）
  | 'legacy_writer'      // 不认识 sidecar.lock 的旧版 sidecar 正持有同目录的定时任务锁

/** 判为陈旧的依据（可回收）。 */
export type StaleReason =
  | 'pid_dead'             // 持有者 PID 不存在（含 Linux zombie）
  | 'started_before_boot'  // 记录启动时间早于本次开机 → 重启后 PID 被复用
  | 'heartbeat_stale'      // 锁文件心跳超过 heartbeatStaleMs 未刷新

export type StoreLockState =
  | { status: 'acquired'; acquired: true; info: LockInfo }
  | { status: 'stale_recovered'; acquired: true; previousOwner: LockInfo; info: LockInfo }
  | { status: 'contended'; acquired: false; holder: StoreLockHolder; reason: LockContentionReason }
  | { status: 'error'; acquired: false; reason: string }

export interface StoreLockConfig {
  /** 锁文件路径；缺省 desktopDir()/sidecar.lock。 */
  lockPath?: string
  /** 心跳刷新间隔（毫秒），默认 10s。 */
  heartbeatIntervalMs?: number
  /** 心跳过期阈值（毫秒），默认 10 分钟。 */
  heartbeatStaleMs?: number
  /** 系统开机时间（毫秒 since epoch）提供者；返回 undefined = 该判据不生效。测试可注入。 */
  bootTimeMs?: () => number | undefined
  /** 锁丢失回调：锁被删除或被其他进程接管时触发（上层据此停掉会话库写入）。 */
  onLockLost?: (state: StoreLockState) => void
  /** 升级过渡期判据读的锁文件；缺省为锁同目录的 scheduled_tasks.lock，传 [] 关闭。 */
  legacyWriterLockPaths?: string[]
  /** 进程真实启动时间（毫秒 since epoch）提供者；返回 undefined = 核验不了。测试可注入。 */
  processStartMs?: (pid: number) => number | undefined
}

export interface StoreLockAcquireOptions {
  /** 重试窗口（毫秒）。0 = 只尝试一次。默认 5000。 */
  retryWindowMs?: number
  /** 重试间隔（毫秒），默认 250。 */
  retryIntervalMs?: number
}

// ─── Paths ────────────────────────────────────────────────────

/** 实际生效的锁路径：desktopDir()（受 RIVET_DESKTOP_DIR / RIVET_HOME 影响）。 */
export function storeLockPath(): string {
  return join(desktopDir(), STORE_LOCK_FILENAME)
}

/**
 * 平台默认真实目录的锁路径——**忽略** RIVET_DESKTOP_DIR / RIVET_HOME。
 * 它既是 node:test 护栏的比较基准（『解析到默认真实目录』），
 * 也让测试能在不依赖环境变量的情况下指认真实路径。
 */
export function platformDefaultStoreLockPath(): string {
  return join(defaultRivetHome(), 'desktop', STORE_LOCK_FILENAME)
}

// ─── Boot Time ────────────────────────────────────────────────

/**
 * 系统开机时间（毫秒 since epoch）。取不到 → undefined（判据不生效，偏保守）。
 * macOS: `sysctl -n kern.boottime` → `{ sec = 1750000000, usec = 0 } ...`
 * Linux: /proc/stat 的 `btime <sec>` 行。
 */
export function readBootTimeMs(): number | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf-8', windowsHide: true })
      const sec = /\bsec\s*=\s*(\d+)/.exec(out)?.[1]
      return toBootMs(sec)
    }
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/stat', 'utf-8')
      return toBootMs(/^btime\s+(\d+)\s*$/m.exec(stat)?.[1])
    }
  } catch {
    // 容器无 procfs / sysctl 缺失 / 权限不足 → 判据不生效
    return undefined
  }
  return undefined
}

function toBootMs(sec: string | undefined): number | undefined {
  if (!sec) return undefined
  const ms = Number(sec) * 1000
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * 进程真实启动时间（毫秒 since epoch，秒级精度）。取不到 → undefined。
 * macOS / Linux 的 `ps -o lstart=` 都是 `Sat Oct  3 22:59:17 2026`（本地时间）；
 * LC_ALL=C 防止日期被本地化后解析失败。
 */
export function readProcessStartMs(pid: number): number | undefined {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    })
    const ms = Date.parse(out.trim())
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    // 进程已退出 / ps 不支持 lstart（busybox）→ 核验不了
    return undefined
  }
}

// 开机时间在一次进程生命周期内不变：只探一次，避免 5s 重试窗口里反复 spawn sysctl。
let bootTimeProbed = false
let cachedBootTimeMs: number | undefined

function defaultBootTimeMs(): number | undefined {
  if (!bootTimeProbed) {
    bootTimeProbed = true
    cachedBootTimeMs = readBootTimeMs()
  }
  return cachedBootTimeMs
}

// ─── Store Lock ───────────────────────────────────────────────

export class StoreLock {
  private readonly lockPath: string
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatStaleMs: number
  private readonly bootTime: () => number | undefined
  private readonly legacyWriterLockPaths: string[]
  private readonly processStartMs: (pid: number) => number | undefined
  private readonly lockLostHandlers = new Set<(state: StoreLockState) => void>()
  private state: StoreLockState | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: StoreLockConfig) {
    this.lockPath = config?.lockPath ?? storeLockPath()
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatStaleMs = config?.heartbeatStaleMs ?? STORE_LOCK_HEARTBEAT_STALE_MS
    this.bootTime = config?.bootTimeMs ?? defaultBootTimeMs
    this.legacyWriterLockPaths = config?.legacyWriterLockPaths
      ?? [join(dirname(this.lockPath), LEGACY_WRITER_LOCK_FILENAME)]
    this.processStartMs = config?.processStartMs ?? readProcessStartMs
    if (config?.onLockLost) this.lockLostHandlers.add(config.onLockLost)
  }

  /**
   * 获取会话库独占锁，在 retryWindowMs 窗口内反复尝试。
   *
   * 返回结构同时给出『是否获得』（status/acquired）与占用者
   * （contended 分支的 holder: {pid, startedAtMs?, hostname?}）。
   */
  async acquire(options?: StoreLockAcquireOptions): Promise<StoreLockState> {
    const guardError = this.testGuardError()
    if (guardError) {
      this.state = guardError
      return guardError
    }

    const windowMs = Math.max(0, options?.retryWindowMs ?? DEFAULT_ACQUIRE_WINDOW_MS)
    const intervalMs = Math.max(10, options?.retryIntervalMs ?? DEFAULT_ACQUIRE_INTERVAL_MS)
    const deadline = Date.now() + windowMs

    let state = this.attemptAcquire()
    while (state.status === 'contended' && Date.now() + intervalMs <= deadline) {
      await sleep(intervalMs)
      state = this.attemptAcquire()
    }

    this.state = state
    if (state.acquired) this.startHeartbeat()
    return state
  }

  /** 释放锁（仅当锁仍属于本进程）。 */
  release(): void {
    this.stopHeartbeat()
    try {
      const owner = readLockFile(this.lockPath)
      if (owner && this.isOwnLockInfo(owner)) unlinkSync(this.lockPath)
    } catch {
      // 清理尽力而为
    }
    this.releaseReclaimLock()
    this.state = null
  }

  /** 当前锁状态。 */
  getState(): StoreLockState | null {
    return this.state
  }

  /** 本进程是否持有锁。 */
  isOwner(): boolean {
    return this.state?.acquired === true
  }

  /**
   * 当前占用者（health 上报用）。undefined = 本进程持有锁、或无人占用。
   * 未持有且没有争用记录时现读一次锁文件，让只探测 health 的实例也能报出占用者。
   */
  holder(): StoreLockHolder | undefined {
    if (this.isOwner()) return undefined
    if (this.state?.status === 'contended') return this.state.holder
    const owner = readLockFile(this.lockPath)
    return owner ? toHolder(owner) : undefined
  }

  /** 注册锁丢失回调。返回取消注册函数。 */
  onLockLost(handler: (state: StoreLockState) => void): () => void {
    this.lockLostHandlers.add(handler)
    return () => {
      this.lockLostHandlers.delete(handler)
    }
  }

  // ─── Internal ──────────────────────────────────────────────

  /**
   * node:test 护栏（P0-1）：测试子进程若把锁路径解析到**默认真实目录**
   * （~/.rivet/desktop/sidecar.lock 或平台默认），直接拒绝——测试绝不能碰真实会话库。
   * RIVET_DESKTOP_DIR / RIVET_HOME 指向别处，或调用方显式传入其他 lockPath → 放行。
   */
  private testGuardError(): StoreLockState | null {
    if (!process.env.NODE_TEST_CONTEXT) return null
    if (resolve(this.lockPath) !== resolve(platformDefaultStoreLockPath())) return null
    return {
      status: 'error',
      acquired: false,
      reason:
        `拒绝在 node:test 进程中操作真实会话库锁（${this.lockPath}）：` +
        '请设置 RIVET_DESKTOP_DIR / RIVET_HOME 指向临时目录，或显式传入 lockPath。',
    }
  }

  /** 单次尝试（不等待）。成功 → 上层负责起心跳。 */
  private attemptAcquire(): StoreLockState {
    const legacy = this.legacyWriter()
    if (legacy) return { status: 'contended', acquired: false, holder: toHolder(legacy), reason: 'legacy_writer' }

    const info = this.buildLockInfo()
    const created = createLockFileExclusive(this.lockPath, info)
    if (created.ok) return { status: 'acquired', acquired: true, info }
    if (created.reason === 'error') return { status: 'error', acquired: false, reason: created.message }

    const owner = readLockFile(this.lockPath)
    // 锁文件损坏/被截断 → 串行 reclaim（禁止裸删：可能删掉刚落地的活锁）
    if (!owner) return this.recoverLock(UNKNOWN_OWNER)

    if (this.isOwnLockInfo(owner)) return { status: 'acquired', acquired: true, info: owner }

    if (owner.hostname !== this.getHostname()) {
      return { status: 'contended', acquired: false, holder: toHolder(owner), reason: 'cross_host' }
    }

    const stale = this.staleReason(owner)
    if (stale) return this.recoverLock(owner)

    return { status: 'contended', acquired: false, holder: toHolder(owner), reason: 'pid_alive' }
  }

  /**
   * 升级过渡期判据：旧版 sidecar 不认识 sidecar.lock，单看它判不出会话库上还有写者；
   * 但每个 sidecar 都抢同目录的定时任务锁，常驻的那个必然持有它（2026-10-04 现场：
   * 旧版桌面端持有定时任务锁、没有 sidecar.lock，打包验证起的新版 sidecar 照样拿到锁并 rehydrate）。
   *
   * 失效方向：只在证据齐全时拦——同主机、不是本进程、PID 活着、记录的启动时间与真实启动时间
   * 对得上（排除 PID 复用）、且不是新版锁主同时持有两把锁。任何一环核验不了就放行，退回只看
   * sidecar.lock：误拦会让桌面端起不来，而那个「持有者」可能只是复用了 PID 的无关进程。
   */
  private legacyWriter(): LockInfo | null {
    for (const path of this.legacyWriterLockPaths) {
      const owner = readLockFile(path)
      if (!owner || owner.pid === process.pid) continue
      if (owner.hostname !== this.getHostname()) continue
      if (!isPidAlive(owner.pid)) continue
      if (typeof owner.startedAtMs !== 'number' || !Number.isFinite(owner.startedAtMs)) continue
      const actualStartMs = this.processStartMs(owner.pid)
      if (actualStartMs === undefined) continue
      if (Math.abs(actualStartMs - owner.startedAtMs) > PROCESS_START_MATCH_TOLERANCE_MS) continue
      if (readLockFile(this.lockPath)?.pid === owner.pid) continue
      return owner
    }
    return null
  }

  /** 三条陈旧判据（按代价从低到高）。null = 视为仍被占用。 */
  private staleReason(owner: LockInfo): StaleReason | null {
    if (!isPidAlive(owner.pid)) return 'pid_dead'

    const bootTimeMs = this.bootTime()
    if (bootTimeMs !== undefined && typeof owner.startedAtMs === 'number' && Number.isFinite(owner.startedAtMs)) {
      if (owner.startedAtMs < bootTimeMs - BOOT_TIME_SKEW_GRACE_MS) return 'started_before_boot'
    }

    const lastBeatMs = this.readHeartbeatMs()
    if (lastBeatMs !== undefined && Date.now() - lastBeatMs > this.heartbeatStaleMs) return 'heartbeat_stale'

    return null
  }

  /** 心跳 = 锁文件 mtime（只读，不重写内容）。stat 失败 → undefined（判据不生效）。 */
  private readHeartbeatMs(): number | undefined {
    try {
      return statSync(this.lockPath).mtimeMs
    } catch {
      return undefined
    }
  }

  /** 串行化回收：先抢 `<lockPath>.reclaim`，再复查锁主是否真的还陈旧。 */
  private recoverLock(previousOwner: LockInfo): StoreLockState {
    const reclaim = this.acquireReclaimLock()
    if (!reclaim.ok) {
      return {
        status: 'contended',
        acquired: false,
        holder: toHolder(readLockFile(this.lockPath) ?? previousOwner),
        reason: 'reclaim_in_progress',
      }
    }

    try {
      const current = readLockFile(this.lockPath)
      if (current && current.pid !== previousOwner.pid) {
        return { status: 'contended', acquired: false, holder: toHolder(current), reason: 'pid_alive' }
      }
      if (current && !this.isOwnLockInfo(current) && this.staleReason(current) === null) {
        // 复查发现锁主仍活/心跳新鲜（例如刚被别人接管）→ 放弃回收
        return { status: 'contended', acquired: false, holder: toHolder(current), reason: 'pid_alive' }
      }

      try {
        unlinkSync(this.lockPath)
      } catch {
        // 其他进程可能已经删掉旧锁；继续走 O_EXCL 竞争
      }

      const info = this.buildLockInfo()
      const recovered = createLockFileExclusive(this.lockPath, info)
      if (recovered.ok) return { status: 'stale_recovered', acquired: true, previousOwner, info }
      if (recovered.reason === 'error') return { status: 'error', acquired: false, reason: recovered.message }

      const owner = readLockFile(this.lockPath)
      return { status: 'contended', acquired: false, holder: toHolder(owner ?? previousOwner), reason: 'pid_alive' }
    } catch (error) {
      return { status: 'error', acquired: false, reason: errorMessage(error) }
    } finally {
      this.releaseReclaimLock()
    }
  }

  private reclaimLockPath(): string {
    return `${this.lockPath}.reclaim`
  }

  private acquireReclaimLock(): { ok: true } | { ok: false; reason: string } {
    const path = this.reclaimLockPath()
    const created = createLockFileExclusive(path, this.buildLockInfo())
    if (created.ok) return { ok: true }
    if (created.reason === 'error') return { ok: false, reason: created.message }

    const owner = readLockFile(path)
    if (owner && this.isOwnLockInfo(owner)) return { ok: true }
    if (owner && !isPidAlive(owner.pid)) {
      try {
        unlinkSync(path)
      } catch {
        // 其他进程可能已经接管 reclaim 锁
      }
      const retry = createLockFileExclusive(path, this.buildLockInfo())
      if (retry.ok) return { ok: true }
      return { ok: false, reason: retry.reason === 'error' ? retry.message : 'exists' }
    }
    return { ok: false, reason: 'exists' }
  }

  private releaseReclaimLock(): void {
    const path = this.reclaimLockPath()
    try {
      const owner = readLockFile(path)
      if (owner && this.isOwnLockInfo(owner)) unlinkSync(path)
    } catch {
      // 清理尽力而为
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (!isMainThread) return
    const timer = setInterval(() => {
      this.heartbeatTick()
    }, this.heartbeatIntervalMs)
    // 心跳绝不能把进程钉在事件循环里
    timer.unref?.()
    this.heartbeatTimer = timer
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 刷新心跳前先确认锁仍属于自己；被别人接管 → 通知上层并停心跳。 */
  private heartbeatTick(): void {
    const owner = readLockFile(this.lockPath)
    if (!owner || !this.isOwnLockInfo(owner)) {
      this.markLockLost(owner ?? UNKNOWN_OWNER)
      return
    }
    try {
      const now = new Date()
      utimesSync(this.lockPath, now, now)
    } catch {
      // 心跳尽力而为：下一次 tick 再试
    }
  }

  private markLockLost(owner: LockInfo): void {
    const wasOwner = this.isOwner()
    const lostState: StoreLockState = {
      status: 'contended',
      acquired: false,
      holder: toHolder(owner),
      reason: 'pid_alive',
    }
    this.state = lostState
    this.stopHeartbeat()
    if (!wasOwner) return
    for (const handler of this.lockLostHandlers) {
      try {
        handler(lostState)
      } catch {
        // 观察者异常不能阻断其他观察者
      }
    }
  }

  private getHostname(): string {
    return osHostname() || 'unknown'
  }

  private buildLockInfo(): LockInfo {
    return {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: this.getHostname(),
      ownerToken: PROCESS_OWNER_TOKEN,
      startedAtMs: PROCESS_STARTED_AT_MS,
    }
  }

  private isOwnLockInfo(info: LockInfo): boolean {
    return info.pid === process.pid &&
      info.hostname === this.getHostname() &&
      info.ownerToken === PROCESS_OWNER_TOKEN &&
      info.startedAtMs === PROCESS_STARTED_AT_MS
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/** 锁文件损坏时用的占位 owner（pid -1 永不匹配现存活进程）。 */
const UNKNOWN_OWNER: LockInfo = { pid: -1, acquiredAt: '', hostname: '' }

function toHolder(info: LockInfo): StoreLockHolder {
  return { pid: info.pid, startedAtMs: info.startedAtMs, hostname: info.hostname }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 供上层（serve.ts 接线）判断是否拿到锁。 */
export function isStoreLockAcquired(state: StoreLockState): boolean {
  return state.acquired
}

/** 供 health / 横幅：未获得锁时的占用者摘要。 */
export function storeLockHolderOf(state: StoreLockState): StoreLockHolder | undefined {
  return state.status === 'contended' ? state.holder : undefined
}

/** 锁是否真的存在（存在性检查，不判定归属）。 */
export function storeLockExists(lockPath: string = storeLockPath()): boolean {
  return existsSync(lockPath)
}
