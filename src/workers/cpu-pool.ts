/**
 * Lazy single-worker pool for CPU-bound tasks.
 *
 * Usage from the main thread:
 *   import { cpuPool } from '../workers/cpu-pool.js'
 *   const result = await cpuPool.run('diffUnifiedRaw', [path, before, after, 4000])
 *
 * Design:
 * - Lazy single worker (spawned on first `run()`, `unref()` so it doesn't
 *   keep the process alive).  Tasks are serialised by the worker's own
 *   message-queue — no explicit main-thread queuing needed.
 * - Soft timeout (default 5s): the promise rejects, caller falls back to
 *   inline computation.  The worker may still be crunching — it finishes or
 *   gets terminated by the hard ceiling on the *next* `run()` call.
 * - Hard ceiling (10s stuck): if the worker hasn't responded to any message
 *   for >10s, `terminate()` + recreate on next `run()`.
 * - Crash recovery: `error`/`exit` events mark the worker dead; next `run()`
 *   spawns a fresh one.
 * - Permanent fallback: `RIVET_CPU_POOL=0` env var disables the worker
 *   entirely — all calls reject immediately, forcing inline paths.
 * - Path resolution: tries `./cpu-worker.js` (dist bundle), then
 *   `./cpu-worker.ts` (tsx dev with `--import tsx/esm`).
 */

import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOFT_TIMEOUT_MS = 5000
const HARD_STUCK_MS = 10_000
/** 空闲回收窗口：任务全部 settle 后 N ms 内无新任务 → terminate worker。
 *  worker 的空闲线程持有 MessagePort（unref 不覆盖），会阻止 node:test
 *  子进程退出——写工具测试（真实执行 edit/write → edit-diff → cpuPool）因此
 *  占住并发槽导致全量套件挂起（2026-08 root-cause）。回收后 _worker=null
 *  且 _dead 不变，下次 run() 重新 spawn，生产高频任务不受影响。
 *  环境变量覆盖供测试注入短值。 */
const IDLE_TERMINATE_MS = (() => {
  const parsed = Number(process.env.RIVET_CPU_POOL_IDLE_MS)
  // 非法/非有限/非正值回退默认：NaN 会让 setTimeout 立即触发，导致每次
  // run() 后 worker 即时回收、下次任务重新 spawn（功能正确但性能抖动）。
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000
})()
const DISABLED = process.env.RIVET_CPU_POOL === '0'

// ── Worker path resolution ──

function resolveWorkerPath(): string | null {
  // Dist: tsup mirrors source structure, so cpu-worker.js is at
  // dist/workers/cpu-worker.js alongside dist/main.js.
  const distUrl = new URL('./workers/cpu-worker.js', import.meta.url)
  try {
    const distPath = fileURLToPath(distUrl)
    if (existsSync(distPath)) return distPath
  } catch { /* URL scheme not file: (unlikely), fall through */ }

  // Dev (tsx): the source files are side-by-side in src/workers/.
  const devUrl = new URL('./cpu-worker.ts', import.meta.url)
  try {
    const devPath = fileURLToPath(devUrl)
    if (existsSync(devPath)) return devPath
  } catch { /* ditto */ }

  return null
}

// ── Pool state ──

let _worker: Worker | null = null
let _dead = DISABLED // permanent-disable flag
let _seq = 0
let _lastTaskStart = 0 // timestamp of the most recent postMessage
let _idleTimer: ReturnType<typeof setTimeout> | null = null // idle-recycle timer

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  clear: () => void
}

const _pending = new Map<number, Pending>()

// ── Idle recycle ─────────────────────────────────────────────

/** 取消待执行的空闲回收（新任务到达时）。 */
function disarmIdleRecycle(): void {
  if (_idleTimer !== null) {
    clearTimeout(_idleTimer)
    _idleTimer = null
  }
}

/** 全部任务 settle 后启动空闲回收计时：超时 terminate worker（可复用）。 */
function armIdleRecycle(): void {
  if (_idleTimer !== null) return
  _idleTimer = setTimeout(() => {
    _idleTimer = null
    if (_worker !== null) {
      retireWorker()
    }
  }, IDLE_TERMINATE_MS)
}

/** 空闲回收的收尾宽限：worker 内停 esbuild 并等其子进程被回收的上限。 */
const RETIRE_GRACE_MS = 1500

/**
 * 空闲回收：先让 worker 停掉 esbuild service 并回收其子进程，再 terminate。
 * 直接 terminate 会让 worker 拉起的 `esbuild --service` 成为永久僵尸——子进程只能
 * 由拉起它的线程 waitpid，线程没了就没人收尸（issue #315：每次写文件后 +1）。
 * worker 立即从池里摘下，期间的新任务直接起新 worker，不受收尾影响。
 */
function retireWorker(): void {
  disarmIdleRecycle()
  const w = _worker
  if (!w || _pending.size > 0) return
  _worker = null
  const id = ++_seq
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    w.terminate().catch(() => { /* already dead */ })
  }
  const timer = setTimeout(finish, RETIRE_GRACE_MS)
  timer.unref?.()
  w.on('message', (msg: { id?: number }) => { if (msg?.id === id) finish() })
  try { w.postMessage({ id, task: 'esbuildStopRaw', args: [] }) } catch { finish() }
}

// ── Internal helpers ──

function spawnWorker(): Worker | null {
  const path = resolveWorkerPath()
  if (!path) return null

  const w = new Worker(path, {
    // node ≥ 23.6 原生 strip-types 已能加载 cpu-worker.ts 及其显式 .ts imports。
    // 此前给 .ts worker 传 ['--import','tsx/esm']：node < 24.11.1 在 worker 线程
    // 不注册钩子（no-op，长期"碰巧正常"）；node ≥ 24.11.1 钩子首次在 worker 生效，
    // 会把 require('<pkg>/package.json') 的 JSON 改写成 esbuild JS 文本——
    // @ast-grep/napi 加载器的版本探测因此抛错，兜底成 "Cannot find native
    // binding"（包完好、dlopen 成功；CI ubuntu+node24 上 ast 全家假红的根因）。
    // 故 .ts worker 一律空 execArgv（不能 undefined——那会继承父进程的
    // --import tsx/--test，行为随父进程漂移）；dist/.js 分支维持 undefined。
    execArgv: path.endsWith('.ts') ? [] : undefined,
  })
  w.unref()
  w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string; infra?: boolean }) => {
    const p = _pending.get(msg.id)
    if (!p) return
    _pending.delete(msg.id)
    p.clear()
    if (msg.ok) p.resolve(msg.result)
    else p.reject(taskError(msg.error, msg.infra))
    if (_pending.size === 0) armIdleRecycle()
  })
  // 只处置「当前」worker：被摘下（空闲回收）或已替换的旧 worker 退出时，
  // 不得连带杀掉新 worker 与它的在途任务。
  w.on('error', () => {
    if (_worker === w) killWorker()
  })
  w.on('exit', () => {
    if (_worker === w) killWorker()
  })
  return w
}

function killWorker(): void {
  disarmIdleRecycle()
  if (!_worker) return
  // Reject all pending promises
  for (const p of _pending.values()) {
    p.clear()
    p.reject(new Error('CPU worker terminated'))
  }
  _pending.clear()
  try { _worker.terminate() } catch { /* already dead */ }
  _worker = null
}

function getWorker(): Worker | null {
  if (_dead) return null

  // Hard-stuck check: if a task has been running >10s, kill and restart
  if (_worker && _lastTaskStart > 0) {
    const stuckMs = Date.now() - _lastTaskStart
    if (stuckMs > HARD_STUCK_MS) {
      killWorker()
    }
  }

  if (!_worker) {
    _worker = spawnWorker()
    if (!_worker) {
      _dead = true
      return null
    }
  }
  return _worker
}

// ── Public API ──

/** worker 报告的「任务自身的基础设施故障」标记——与输入无关（工具链坏了、
 *  平台二进制包缺失、service 起不来…）。调用方应据此静默降级/熔断，而不是把
 *  message 当业务信号渲染给模型（issue #366：esbuild 平台包缺失被渲染成
 *  「语法检查提示」）。分类在错误产生点（cpu-tasks）完成，跨线程只传标记。 */
export interface InfraTaskError extends Error {
  infra: true
}

export function isInfraTaskError(err: unknown): err is InfraTaskError {
  return typeof err === 'object' && err !== null && (err as { infra?: unknown }).infra === true
}

function taskError(message: string | undefined, infra?: boolean): Error {
  const err = new Error(message ?? 'unknown worker error')
  if (infra === true) (err as Partial<InfraTaskError>).infra = true
  return err
}

export const cpuPool = {
  /**
   * Run a named task in the worker thread.
   *
   * Returns the task's result on success, or throws an Error if the worker is
   * unavailable / the task times out.  Callers should catch and fall back to
   * inline computation.
   *
   * @param task    — key in the worker's task registry (cpu-worker.ts)
   * @param args    — positional arguments forwarded to the task function
   * @param softMs  — soft timeout in ms (default 5s)
   */
  run(task: string, args: unknown[], softMs = SOFT_TIMEOUT_MS): Promise<unknown> {
    const worker = getWorker()
    if (!worker) return Promise.reject(new Error('CPU pool unavailable'))
    disarmIdleRecycle()

    return new Promise<unknown>((resolve, reject) => {
      const id = ++_seq
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        _pending.delete(id)
        reject(new Error(`CPU task '${task}' timed out after ${softMs}ms`))
        if (_pending.size === 0) armIdleRecycle()
      }, softMs)

      const clear = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
      }

      _pending.set(id, { resolve, reject, clear })
      _lastTaskStart = Date.now()
      worker.postMessage({ id, task, args })
    })
  },

  /** True when the worker is (or can be) running. */
  get available(): boolean {
    return !DISABLED && !_dead
  },

  /**
   * Terminate the worker (if any) and mark the pool permanently dead.
   * Use at process shutdown / test teardown: the lazily spawned worker holds
   * a MessagePort that keeps node:test from exiting even though it is unref'd
   * (worker stays alive waiting for messages).
   */
  dispose(): void {
    killWorker()
    _dead = true
  },
}
