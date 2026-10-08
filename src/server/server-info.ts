/**
 * serve 实例发现文件（server-info.json）——跨进程/跨 OS 边界的握手面。
 *
 * 动机（WSL Remote，2026-09）：桌面壳跑在 Windows，agent 内核跑在 WSL。壳需要
 * 在不 spawn 本地 sidecar 的情况下发现「已经在 WSL 里跑着的 rivet serve」的
 * port/token。serve 侧的单一真源就是这个文件：listen 成功后把坐标写进
 * `$RIVET_HOME/server-info.json`，关闭时（且仅当 pid 仍归属自己时）移除。
 *
 * 竞态契约（多实例先后启动的关键不变量）：
 *   写入侧互斥靠 OS 的原子 rename（同目录 writeFileSync+rename 模式），语义是
 * 「最后写的赢」——两个 serve 实例先后启动时，后者的发现文件覆盖前者。这正确：
 *   发现方探测健康后连接的是最后存活的实例。
 *   清除侧必须校验 pid 归属：实例 A 先退、实例 B 仍在跑时，A 的退出流程绝不能
 *   删掉 B 的发现文件。比较 pid 而非内容——pid 复用窗口极小且发现方有健康探测
 *   兜底（读到旧文件 → 探测失败 → 视为无实例），不为 astronomically-rare 的
 *   pid 复用引入内容比较的复杂度。
 *
 * 读写全部 best-effort（对齐 writeExitBreadcrumb）：发现文件是优化面不是正确性
 * 面——写不进磁盘时 serve 照常服务，只是桌面壳发现不了它。
 */
import { writeFileSync, renameSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { setServerLogger, formatLog } from './logger.js'
import { ensurePrivateDirectory, protectPrivatePath } from '../platform/private-path.js'

/** 发现文件记录的坐标。字段最小化：port/token/pid 是握手必需，host/startedAt 供诊断。 */
export interface ServerInfo {
  protocol?: 'http' | 'https'
  port: number
  /** 监听地址（serve 的 --host/RIVET_SERVE_HOST 解析结果）。 */
  host: string
  token: string
  pid: number
  startedAt: string
}

/** 发现文件路径。RIVET_HOME 动态解析——每次调用重读，与 rivetHome() 同源。 */
export function serverInfoPath(): string {
  return join(rivetHome(), 'server-info.json')
}

/**
 * 原子写发现文件：先写同目录临时文件再 rename，读者永远看不到半截 JSON。
 * 语义「最后写的赢」——见文件头竞态契约。
 * 文件含明文 Bearer token，mode 0600（owner-only）——rename 原子保持权限，
 * 不按 umask 落 644。Windows 在写入令牌前收紧目录与空临时文件 ACL；失败不发布发现文件。
 */
export function writeServerInfo(info: ServerInfo, filePath = serverInfoPath(), protection = { ensurePrivateDirectory, protectPrivatePath }): void {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let created = false
  try {
    protection.ensurePrivateDirectory(dirname(filePath))
    writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' })
    created = true
    protection.protectPrivatePath(tmp)
    writeFileSync(tmp, JSON.stringify(info, null, 2))
    renameSync(tmp, filePath)
  } catch {
    // Discovery is optional; never publish plaintext when protection fails.
    if (created) { try { unlinkSync(tmp) } catch { /* best-effort cleanup */ } }
  }
}

/**
 * 读发现文件。损坏/缺字段/不可解析一律返回 undefined——调用方（attach 逻辑、
 * 桌面壳）拿 undefined 走「无实例」分支，不为坏文件炸出一条新的失败路径。
 */
export function readServerInfo(filePath = serverInfoPath()): ServerInfo | undefined {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ServerInfo>
    if (
      typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535 &&
      typeof parsed.token === 'string' && parsed.token.length > 0 &&
      typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) &&
      typeof parsed.startedAt === 'string' &&
      (parsed.protocol === undefined || parsed.protocol === 'http' || parsed.protocol === 'https') &&
      (parsed.host === undefined || (typeof parsed.host === 'string' && parsed.host.length > 0))
    ) {
      // host 缺省视为回环（v1 无 host 字段的旧文件 / 手写场景）
      return { host: '127.0.0.1', ...parsed } as ServerInfo
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 清除发现文件——仅当记录的 pid 仍归属当前进程时才删（竞态契约的清除侧）。
 * 供 serve 关停链调用。同样 best-effort。
 */
export function clearServerInfo(filePath = serverInfoPath(), pid = process.pid): void {
  try {
    const info = readServerInfo(filePath)
    if (info && info.pid !== pid) return
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    // best-effort
  }
}

/**
 * 探测一个已记录的 serve 实例是否仍然健康（GET /status 期待 200 + JSON body）。
 *
 * attach 语义的核心探测：发现文件只是「曾经有实例」的证据，连得上才是「现在
 * 有实例」。默认 liveness probe 走 fetch；测试注入假 probe 隔离网络。probe 期望
 * 返回 boolean——true 才继续用这份 info。
 */
export async function isServerInfoAlive(
  info: ServerInfo,
  probe: (info: ServerInfo) => Promise<boolean> = defaultLivenessProbe,
): Promise<boolean> {
  try {
    return await probe(info)
  } catch {
    return false
  }
}

/**
 * 探测 URL：host 含冒号视为 IPv6 字面量，需方括号包裹才能构造合法 URL
 * （`http://::1:3100` 非法，`http://[::1]:3100` 合法）。0.0.0.0/:: 作为目的地
 * 在 Linux/macOS 上按本机处理，可直接探测。
 */
export function probeUrlFor(info: ServerInfo): string {
  const host = info.host.includes(':') ? `[${info.host}]` : info.host
  return `${info.protocol ?? 'http'}://${host}:${info.port}/status`
}

/** 默认探测：Bearer token 打 /status，200 + 可解析 JSON 即活。 */
async function defaultLivenessProbe(info: ServerInfo): Promise<boolean> {
  const res = await fetch(probeUrlFor(info), {
    headers: { Authorization: `Bearer ${info.token}` },
    signal: AbortSignal.timeout(2000),
  })
  if (!res.ok) return false
  await res.json()
  return true
}

export interface AttachHandshakeOptions {
  /** --json：stdout 只输出一行坐标 JSON（桌面壳解析），banner 走 stderr。 */
  jsonMode: boolean
  /** stdout 写出口（注入隔离；serveCommand 传 console.log）。 */
  print: (line: string) => void
}

/**
 * `rivet serve --attach` 的握手决策：发现活实例 → 打印坐标、返回 true（调用方
 * 在 stdout drain 后 process.exit(0)）；stale/无文件 → 返回 false，调用方落入
 * 正常起 serve（新实例覆盖 stale 文件，「最后写的赢」契约）。
 *
 * --json 模式（wsl remote 主通道）：桌面壳经 `wsl.exe -e rivet serve --attach
 * --json` 读 stdout 恰一行 `{attached, port, host, token, pid}`——零文件跨界
 * （无 9P）、零 distro 枚举，发现与启动合一。
 */
export async function resolveAttachHandshake(opts: AttachHandshakeOptions): Promise<boolean> {
  const existing = readServerInfo()
  if (!existing || !(await isServerInfoAlive(existing))) return false
  if (opts.jsonMode) {
    opts.print(JSON.stringify({ attached: true, port: existing.port, host: existing.host, ...(existing.protocol ? { protocol: existing.protocol } : {}), token: existing.token, pid: existing.pid }))
  } else {
    opts.print(`Rivet serve already running (pid ${existing.pid}) — attaching`)
    opts.print(`Rivet Runtime API at ${probeUrlFor(existing)}`)
  }
  return true
}

/**
 * --json 握手的另一半：serveCommand 新起实例后的坐标输出。坐标由 runServe 的
 * 返回值直供（RunningServer.serverInfo，内存真源）——不回读发现文件：两个
 * serve 实例并发新起时后者会覆盖前者的文件（「最后写的赢」），回读会让自己
 * 输出成别人的坐标，两个桌面壳都连向后者、前者成无人知晓的孤儿。
 * token 属 fail-closed 秘密：memory 中必有（runServe fail-closed 拒启无 token）。
 */
export function printSpawnedHandshake(info: ServerInfo, print: (line: string) => void): void {
  print(JSON.stringify({
    attached: false,
    port: info.port,
    host: info.host,
    ...(info.protocol ? { protocol: info.protocol } : {}),
    token: info.token,
    pid: info.pid,
  }))
}

/**
 * jsonMode 的 stdout 纯度：serverLogger.info 默认走 console.log（stdout）——
 * cron startup/app-open trigger（每次启动 fire）与 event-triggers 的 info 行
 * 会污染握手主通道。整体重定向到 stderr；warn/error 本就走 stderr 不动。
 */
export function enableJsonModeStdoutPurity(): void {
  setServerLogger({
    info: (message, context) => console.error(formatLog('INFO', message, context)),
    warn: (message, context) => console.warn(formatLog('WARN', message, context)),
    error: (message, context) => console.error(formatLog('ERROR', message, context)),
  })
}

/**
 * `--attach` 的 CLI 接线：附着成功 → 握手行写 stdout，**在 write 回调里退出**。
 * 管道场景（wsl.exe stdio）stdout 是异步的——写后同步 process.exit 会丢弃未
 * flush 的缓冲，桌面壳读到半行 JSON；write 回调保证数据已交内核再退。未附着
 * → 纯返回，调用方落入正常起 serve（新实例覆盖 stale 文件，「最后写的赢」）。
 */
export async function attachOrExit(jsonMode: boolean): Promise<void> {
  const lines: string[] = []
  const attached = await resolveAttachHandshake({ jsonMode, print: (l) => lines.push(l) })
  if (!attached) return
  process.stdout.write(lines.join('\n') + '\n', () => process.exit(0))
}
