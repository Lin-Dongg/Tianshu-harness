/**
 * E1 sidecar 启动器：spawn `rivet serve` → 健康检查。
 *
 * 每工作区一个实例；127.0.0.1 + 随机 Bearer token（fail-closed，与 server
 * 侧 RIVET_SERVER_TOKEN 语义对齐）。P0 实现运行时三级探测的 ①（PATH 上的
 * rivet）与 ③（settings 指定路径）；②自包含运行时下载在 P3。
 *
 * 探测策略：不用 `--version` 探活——CLI 的 TTY 守卫（T9）会在非 TTY 环境把
 * 顶层命令挡下（实测 exit 1）；`serve` 子命令是桌面端非 TTY spawn 的既有
 * 路径不受影响。因此直接 spawn serve：ENOENT → cli-not-found，起不来 →
 * 健康检查超时。
 *
 * P0-3 会话库隔离：调用方可用 `desktopDir` 给 sidecar 一个独立数据根（注入
 * RIVET_DESKTOP_DIR——`src/config/paths.ts` 的 desktopDir() 读它，旧版 CLI 也认）。
 * 不提供时沿用继承来的环境，也就是桌面端默认的 `~/.rivet/desktop`：那个目录下
 * 插件 sidecar 的启动 rehydrate 会把桌面端正在跑的会话标成假中断，两个进程还会
 * 争用同一份 sidecar.lock。提供后插件会话与桌面端列表分离，插件 sidecar 也不再
 * 参与桌面端的定时任务（scheduled_tasks.json / run-ledgers 等都在同一下面）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import * as os from 'node:os'
import { join } from 'node:path'
import { resolveCliCommand } from './cli-command.js'

export interface SidecarHandle {
  port: number
  token: string
  baseUrl: string
  /** 结束进程树并等待退出（幂等）。 */
  dispose: () => Promise<void>
  /** 进程退出时回调（异常退出用于 UI 提示 + 重启入口）。 */
  onExit: (cb: (code: number | null) => void) => void
}

export interface LauncherOptions {
  cwd: string
  /** settings 指定的 CLI 路径（三级探测③），空串/未设置回退 PATH 上的 rivet。 */
  cliPath?: string
  /** settings 指定端口，0 = 自动选空闲端口。 */
  port?: number
  /**
   * 会话库根（P0-3）：非空时注入 RIVET_DESKTOP_DIR，本 sidecar 用独立库。
   * 空/未设置时继承环境（= 桌面端默认库，只适合单实例场景）。
   */
  desktopDir?: string
  /** 日志行回调（接 OutputChannel）。 */
  onLog?: (line: string) => void
  /** 启动未完成时取消健康检查并回收进程。 */
  signal?: AbortSignal
}

export type LaunchFailReason =
  | 'cli-not-found'
  | 'spawn-failed'
  | 'health-timeout'
  | 'cleanup-failed'
  /** 会话库被别的进程独占（health 自报 initializationError: data-dir-locked）——重试无用，先关占用者。 */
  | 'data-dir-locked'
  /** 其余初始化失败（health 自报 readiness: failed）——具体原因在 message 里。 */
  | 'initialization-failed'

export class SidecarLaunchError extends Error {
  readonly reason: LaunchFailReason
  constructor(message: string, reason: LaunchFailReason) {
    super(message)
    this.reason = reason
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('failed to allocate port')))
      }
    })
    srv.on('error', reject)
  })
}

/** /health 体里与就绪判定相关的字段；字段缺失（老运行时/匿名响应）按「未失败」处理。 */
interface HealthProbe {
  readiness?: string
  initializationError?: string
  storeLockHolder?: { pid?: number; hostname?: string }
}

/** 读 health 体；非 JSON（老运行时、HTML 错误页、空体）返回 undefined，不当作失败。 */
async function readHealthProbe(res: Response): Promise<HealthProbe | undefined> {
  if (typeof (res as { json?: unknown }).json !== 'function') return undefined
  try {
    const body: unknown = await res.json()
    return body && typeof body === 'object' ? (body as HealthProbe) : undefined
  } catch {
    return undefined
  }
}

/** readiness=failed 的失败码映射（与桌面端壳的 failed_readiness_reason 同一口径）。 */
function readinessFailure(probe: HealthProbe): SidecarLaunchError {
  const cause = probe.initializationError
  const holder = probe.storeLockHolder
  const holderText = holder
    ? `，占用者 pid ${holder.pid ?? '未知'}${holder.hostname ? ` @ ${holder.hostname}` : ''}`
    : ''
  if (cause === 'data-dir-locked') {
    return new SidecarLaunchError(
      `sidecar 会话库已被另一个天枢进程独占（initializationError: data-dir-locked${holderText}）。请先关闭占用该目录的进程后重试。`,
      'data-dir-locked',
    )
  }
  return new SidecarLaunchError(
    `sidecar 初始化失败（initializationError: ${cause ?? 'unknown'}${holderText}）`,
    'initialization-failed',
  )
}

async function waitHealthy(
  baseUrl: string,
  token: string,
  child: ChildProcess,
  getSpawnError: () => Error | undefined,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const spawnErr = getSpawnError()
    if (spawnErr) {
      const code = (spawnErr as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new SidecarLaunchError(
          '未找到 rivet CLI。请先安装（npm i -g tianshu-harness），或在设置 tianshu.cliPath 中指定路径。',
          'cli-not-found',
        )
      }
      throw new SidecarLaunchError(`sidecar 启动失败: ${spawnErr.message}`, 'spawn-failed')
    }
    if (child.exitCode !== null) {
      throw new SidecarLaunchError(`sidecar 启动失败（exit ${child.exitCode}）`, 'spawn-failed')
    }
    const healthController = new AbortController()
    const cancelHealth = () => healthController.abort()
    const timer = setTimeout(cancelHealth, 2_000)
    signal?.addEventListener('abort', cancelHealth, { once: true })
    let probe: HealthProbe | undefined
    let ok = false
    try {
      const res = await fetch(`${baseUrl}/health`, {
        // 带 token 才有全量体（含 readiness / initializationError / storeLockHolder）；
        // 匿名探测只回 {ok, version}，识别不出初始化失败。
        headers: { authorization: `Bearer ${token}` },
        signal: healthController.signal,
      })
      ok = res.ok
      probe = await readHealthProbe(res)
    } catch {
      // not up yet
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelHealth)
    }
    // 分类在 catch 之外：进程已起来并自报初始化失败时不能当成「还没起来」继续等，
    // 否则只会等到 20s 超时（且把锁冲突报成 health-timeout）。
    if (probe?.readiness === 'failed') throw readinessFailure(probe)
    if (ok) return
    signal?.throwIfAborted()
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new SidecarLaunchError('sidecar 健康检查超时（20s）', 'health-timeout')
}

export async function launchSidecar(opts: LauncherOptions): Promise<SidecarHandle> {
  opts.signal?.throwIfAborted()
  const cli = opts.cliPath?.trim() || 'rivet'
  const port = opts.port && opts.port > 0 ? opts.port : await pickFreePort()
  opts.signal?.throwIfAborted()
  const token = randomBytes(24).toString('hex')
  const baseUrl = `http://127.0.0.1:${port}`

  const command = resolveCliCommand(cli, ['serve', '--port', String(port)], opts.cwd)
  // P0-3：独立会话库——有值时覆盖继承来的 RIVET_DESKTOP_DIR（含桌面端默认值）。
  const desktopDir = opts.desktopDir?.trim()
  const env: NodeJS.ProcessEnv = { ...process.env, RIVET_SERVER_TOKEN: token }
  if (desktopDir) env.RIVET_DESKTOP_DIR = desktopDir
  const child = spawn(command.command, command.args, {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })
  let spawnError: Error | undefined
  let settleStopped!: () => void
  const stopped = new Promise<void>((resolve) => { settleStopped = resolve })
  child.on('error', (err) => {
    spawnError = err
    if (!child.pid) settleStopped()
  })

  const log = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) opts.onLog?.(line)
    }
  }
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)

  const exitCbs: Array<(code: number | null) => void> = []
  let disposed = false
  let disposal: Promise<void> | undefined
  child.on('exit', (code) => {
    settleStopped()
    if (!disposed) for (const cb of exitCbs) cb(code)
  })
  const dispose = (): Promise<void> => {
    if (!disposal) {
      disposed = true
      disposal = (async () => {
        if (os.platform() === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve, reject) => {
            const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
            const fail = (message: string) => {
              if (child.exitCode !== null || child.signalCode !== null) resolve()
              else reject(new SidecarLaunchError(message, 'cleanup-failed'))
            }
            killer.once('error', (err) => fail(`sidecar 进程树回收失败: ${err.message}`))
            killer.once('close', (code) => {
              if (code === 0) resolve()
              else fail(`sidecar 进程树回收失败（taskkill exit ${code}）`)
            })
          })
        } else {
          child.kill()
        }
        await stopped
      })()
    }
    return disposal
  }
  let cancelLaunch!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelLaunch = () => {
      void dispose().catch(() => {})
      reject(new Error('sidecar 启动已取消'))
    }
  })
  opts.signal?.addEventListener('abort', cancelLaunch, { once: true })

  try {
    if (opts.signal?.aborted) cancelLaunch()
    await Promise.race([waitHealthy(baseUrl, token, child, () => spawnError, opts.signal), cancelled])
  } catch (err) {
    await dispose()
    throw err
  } finally {
    opts.signal?.removeEventListener('abort', cancelLaunch)
  }

  return {
    port,
    token,
    baseUrl,
    dispose,
    onExit: (cb) => exitCbs.push(cb),
  }
}
