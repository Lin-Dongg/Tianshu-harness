/**
 * 监听地址 / Host 头的回环判定——单一真源。
 *
 * 抽取动机（2026-09 审查）：此前 `index.ts` 与 `remote-info-routes.ts` 各持一份
 * 判定，两份都把 `'::'` 归入回环。`'::'` 是 IPv6 通配地址（双栈下等效 0.0.0.0），
 * 与只监听本机的 `'::1'` 性质相反——index.ts 里紧邻的注释自己写着「LAN 模式：
 * 0.0.0.0 / LAN IP / ::」，代码与注释矛盾。判错的双重后果：① `--host ::` 下
 * `lanMode=false`，非回环 Host 全被 403，手机根本到不了 `/mobile`；②
 * `/remote/info` 误报 `mode:'loopback'`，桌面设置页 QR 门控短路不画码，还反向
 * 引导用户去「启用 LAN」。
 *
 * 收敛到本模块后两端共用同一实现，避免再次漂移。
 */

import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'

/** 去掉 IPv6 字面量的方括号包裹，并归一大小写/空白（`[::1]` → `::1`）。 */
function unbracket(addr: string): string {
  const a = addr.trim().toLowerCase()
  return a.startsWith('[') && a.endsWith(']') ? a.slice(1, -1) : a
}

/** IPv4 回环整段 `127.0.0.0/8`，以及 IPv4-mapped 的回环形态 `::ffff:127.x`。 */
function isLoopbackAddress(addr: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
    || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
}

/**
 * 绑定地址是否为回环形态（决定 startServer 是否进入 LAN 模式）。
 *
 * 通配绑定（`0.0.0.0` / `::`）不是回环——它们监听全部接口。`::` 尤其不能漏：
 * 双栈系统上只写 `::` 就等于同时绑 IPv4 与 IPv6 的全部接口。
 */
export function isLoopbackBind(addr: string): boolean {
  const a = unbracket(addr)
  return a === 'localhost' || a === '::1' || (isIP(a) !== 0 && isLoopbackAddress(a))
}

/** Default to this machine's literal addresses; unknown hosts remain denied. */
export function defaultLanHosts(bindHost: string): string[] {
  const hosts = new Set<string>()
  if (!['0.0.0.0', '::'].includes(bindHost)) hosts.add(bindHost.toLowerCase())
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
    hosts.add(address.family === 'IPv6' ? `[${address.address.toLowerCase()}]` : address.address)
  }
  return [...hosts]
}

/** 拆 Host 头为 host / port 两部分（port 缺省为 undefined）。 */
function splitHostPort(h: string): { host: string; port?: number } {
  const raw = h.trim().toLowerCase()
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return { host: raw }
    const host = raw.slice(0, end + 1)
    const rest = raw.slice(end + 1)
    if (rest.startsWith(':')) {
      const port = Number(rest.slice(1))
      if (Number.isInteger(port)) return { host, port }
    }
    return { host }
  }
  const colon = raw.lastIndexOf(':')
  if (colon > 0) {
    const port = Number(raw.slice(colon + 1))
    if (Number.isInteger(port)) return { host: raw.slice(0, colon), port }
  }
  return { host: raw }
}

/**
 * Host 头是否为回环形态：host 属回环集合，且端口缺省（HTTP/1.0 风格）或与本
 * 服务端口一致。端口一致是防 DNS-rebinding 的关键——`127.0.0.1:其他端口` 不
 * 是本站。
 */
export function isLoopbackHostHeader(h: string, p: number): boolean {
  const { host, port } = splitHostPort(h)
  if (port !== undefined && port !== p) return false
  return isLoopbackBind(host)
}

/** 去 Host 端口（allowlist 精确比较用）：`[::1]:8080` → `[::1]`；`127.0.0.1:9` → `127.0.0.1`。 */
export function stripHostPort(h: string): string {
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end >= 0 ? h.slice(0, end + 1) : h
  }
  const colon = h.lastIndexOf(':')
  return colon > 0 ? h.slice(0, colon) : h
}

/**
 * 解析 RIVET_SERVE_HOSTS_ALLOW：逗号分隔、去空、拒绝含 / 或 : 的形态（无端口/无路径）。
 * 全条目非法时返回 undefined 并 console.warn——保留「忽略」语义但不再静默：否则 LAN
 * bind + 全非法 allowlist 会无声退化为「任意 Host 放行」（P1 fail-open 缺陷修复）。
 *
 * 2026-09 从 serve.ts 迁入：allowlist 是 host 判定的一部分，本文件是 host 策略的
 * 单一真源（见文件头），此前住在 serve.ts 是位置错误——serve.ts 已触及结构预算
 * ceiling，沿此接缝拆分。
 */
export function parseHostsAllow(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const out: string[] = []
  for (const part of raw.split(',')) {
    const h = part.trim().toLowerCase()
    if (!h || h.includes('/') || h.includes(':')) continue
    out.push(h)
  }
  if (out.length === 0) {
    console.warn(
      `[serve] RIVET_SERVE_HOSTS_ALLOW="${raw}" had no valid host entries ` +
        '(each must be a bare hostname/IP without "/" or ":"); allowlist uses ' +
        'the default local-address list; unknown hosts remain denied.',
    )
  }
  return out.length > 0 ? out : undefined
}
