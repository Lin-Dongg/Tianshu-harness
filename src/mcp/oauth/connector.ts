// MCP OAuth connector — per-server PKCE token lifecycle.
//
// Reuses the same OAuth primitives (PKCE, TokenStore, refresh) as the main
// Codex auth in src/auth/, but with per-serverId token storage and generic
// provider endpoints (not hardcoded to OpenAI's auth domain).

import { randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'
import { join } from 'node:path'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import undici from 'undici'
import { generatePKCE, buildAuthorizeUrl } from '../../auth/oauth.js'
import { TokenStore, type TokenData } from '../../auth/token-store.js'
import { shouldRefresh } from '../../auth/refresh.js'
import { rivetHome } from '../../config/paths.js'
import { resolveAndAssertPublic } from '../../tools/net/ssrf.js'
import { buildPinnedLookup } from '../../tools/net/http-fetch.js'
import { resolveProxyForUrl } from '../../tools/net/proxy-resolver.js'
import type { McpOAuthProvider, McpOAuthToken } from './types.js'

const REDIRECT_PORT = parseInt(process.env.RIVET_OAUTH_PORT || '1456', 10)
const CALLBACK_PATH = '/auth/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60_000
const OAUTH_TIMEOUT_MS = 30_000
/** 凭据响应体上限：token 响应本身只有几百字节到几 KB，`response.text()` 会让
 *  恶意端点用一个超大正文把内存撑爆。量级与 src/auth/oauth-auth.ts 的
 *  readErrorBodyCapped（64 KiB）对齐。 */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024

/** Per-server OAuth token directory — separate from the main Codex auth store. */
function mcpOAuthDir(): string {
  return join(rivetHome(), 'mcp-oauth')
}

function tokenStore(serverId: string): TokenStore {
  return new TokenStore(mcpOAuthDir(), serverId)
}

/** 已开始、尚未完成的 OAuth 流程——授权页 URL 立即交出，回调与换 token 在后台跑。 */
export interface McpOAuthBegin {
  /** 授权页 URL——由调用方负责打开（TUI 打 stderr；桌面端 openExternal）。 */
  authUrl: string
  /** 回调等待 + code 交换 + 落盘的完整流程；成功 resolve token，超时/被拒 reject。
   *  调用方必须立即挂 then/catch——不挂的话 reject 会变 unhandled。 */
  completion: Promise<McpOAuthToken>
}

/**
 * 开始 OAuth 流程但**不阻塞等待**：拿到授权页 URL 即返回，回调监听与换 token
 * 收进 completion。桌面 sidecar 用（端点先把 authUrl 还给前端开浏览器，前端再
 * 轮询 oauth/status）——serveCallback 只把 URL 写 stderr，桌面端用户看不到。
 */
export async function beginMcpOAuth(
  serverId: string,
  provider: McpOAuthProvider,
  clientId: string,
  extraScopes?: string[],
): Promise<McpOAuthBegin> {
  const pkce = await generatePKCE()
  const state = randomBytes(16).toString('hex')
  const redirectUri = `http://localhost:${REDIRECT_PORT}${CALLBACK_PATH}`
  const scopes = [...provider.defaultScopes, ...(extraScopes ?? [])]

  const authUrl = buildAuthorizeUrl({
    clientId,
    codeChallenge: pkce.challenge,
    redirectUri,
    state,
    authorizeBase: provider.authorizeUrl,
  })
  // Override the default 'openid profile email offline_access' scope string
  // that buildAuthorizeUrl produces — MCP providers have their own scopes.
  const url = new URL(authUrl)
  url.searchParams.set('scope', scopes.join(' '))

  const completion = (async () => {
    const code = await serveCallback(REDIRECT_PORT, state, url.toString())
    const token = await exchange(code, pkce.verifier, redirectUri, provider, clientId)
    // Save metadata (provider, scopes) alongside the raw TokenData so
    // loadMcpOAuthToken can reconstruct the full McpOAuthToken.
    tokenStore(serverId).save({
      ...token,
      _provider: provider.id,
      _scopes: scopes,
    } as TokenData & { _provider: string; _scopes: string[] })
    return { ...token, provider: provider.id, scopes }
  })()
  return { authUrl: url.toString(), completion }
}

/** Start the full OAuth flow for a given server + provider.
 *  Returns the serialized token on success. */
export async function startMcpOAuth(
  serverId: string,
  provider: McpOAuthProvider,
  clientId: string,
  extraScopes?: string[],
): Promise<McpOAuthToken> {
  const { completion } = await beginMcpOAuth(serverId, provider, clientId, extraScopes)
  return completion
}

/** Get a fresh access token for a server, refreshing if needed. */
export async function getMcpAccessToken(serverId: string, provider: McpOAuthProvider, clientId: string): Promise<string> {
  const store = tokenStore(serverId)
  let token = store.load()
  if (!token) throw new Error(`No OAuth token for MCP server "${serverId}" — run /mcp auth ${serverId}`)

  if (shouldRefresh(token)) {
    token = await refreshMcpToken(token, provider, clientId)
    store.save(token)
  }

  return token.accessToken
}

/** Check if a server has a valid (non-expired) OAuth token. */
export function hasMcpOAuthToken(serverId: string): boolean {
  const token = tokenStore(serverId).load()
  return token !== null && token.expiresAt > Date.now()
}

/** Remove the OAuth token for a server (disconnect). */
export function revokeMcpOAuth(serverId: string): void {
  tokenStore(serverId).clear()
}

/** Load the stored OAuth token for a server (null if none or expired). */
export function loadMcpOAuthToken(serverId: string): McpOAuthToken | null {
  const data = tokenStore(serverId).load() as (TokenData & { _provider?: string; _scopes?: string[] }) | null
  if (!data) return null
  if (data.expiresAt <= Date.now()) return null
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    provider: data._provider ?? '',
    scopes: data._scopes ?? [],
  }
}

// ── internals ──

/** Pending OAuth callback keyed by state. Allows multiple concurrent flows to
 *  share the same localhost redirect port without port conflicts. */
type PendingCallback = {
  resolve: (code: string) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let sharedServer: Server | null = null
let sharedServerPort: number | null = null
let serverStartPromise: Promise<void> | null = null
/** 回调服务器处于「关」态（含从未启动）。close 与 listen 完成的竞态里，
 *  listen 回调与 serveCallback 都按它决定是领养还是立即关回——不判就会出现
 *  close 后又被重新挂上监听的复活泄漏（2026-10-04 实测吊住测试进程）。 */
let sharedServerClosed = true
const pendingCallbacks = new Map<string, PendingCallback>()

async function getOrStartSharedServer(port: number): Promise<void> {
  if (sharedServer && sharedServerPort === port) return
  if (serverStartPromise) {
    // A start/stop transition is in progress; wait for it to settle.
    await serverStartPromise
    // If the port still doesn't match, recurse once (shouldn't happen in practice).
    if (sharedServerPort !== port) return getOrStartSharedServer(port)
    return
  }

  serverStartPromise = new Promise<void>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      handleCallbackRequest(req, res)
    })
    // 进入「开」态必须在 listen 之前——listen 回调的竞态判据就指望它：
    // close 先到则回调里看到 closed=true 立即关回。
    sharedServerClosed = false
    server.once('error', (err) => {
      const wasStarting = serverStartPromise !== null
      const allPending = Array.from(pendingCallbacks.values())
      closeSharedServer().catch(() => {})
      if (wasStarting) {
        reject(err)
      } else {
        for (const pending of allPending) pending.reject(err)
      }
    })

    // 绑回环：回调只需本机浏览器可达，不传 host 会监听所有接口——LAN 上的机器
    // 也能连这个端口，而它是 code 交换面（与 src/auth/oauth-auth.ts 的回调
    // 服务器同一口径：state+PKCE 已兜底，仍要收紧暴露面）。
    // 代价：IPv6 回环（::1）不再可达（实测 ECONNREFUSED）——浏览器对 localhost
    // 通常有 IPv4 回退，且与 oauth-auth.ts 同口径，故接受。
    server.listen(port, '127.0.0.1', () => {
      if (sharedServerClosed) {
        // close 与 listen 完成撞在同一代际——立即关回，不得领养。
        server.close(() => {})
        reject(new Error('OAuth callback server closed'))
        return
      }
      sharedServer = server
      sharedServerPort = port
      resolve()
    })
  })

  try {
    await serverStartPromise
  } finally {
    // Only clear the start promise if we are still the current start attempt.
    if (serverStartPromise) serverStartPromise = null
  }
}

async function closeSharedServer(): Promise<void> {
  sharedServerClosed = true
  const server = sharedServer
  sharedServer = null
  sharedServerPort = null
  serverStartPromise = null
  // 拒掉在途回调——对应的 serveCallback promise 以 error 落定（completion 走
  // catch），而不是永远 pending 把调用方的句柄挂在半空。
  for (const pending of pendingCallbacks.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error('OAuth callback server closed'))
  }
  pendingCallbacks.clear()
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** @internal 测试专用：关共享回调服务器、清在途回调与超时句柄（否则监听 + 5 分钟
 *  超时把测试进程的事件循环吊住——runner 已移除 --test-force-exit）。生产不需要：
 *  CALLBACK_TIMEOUT_MS 是在途流程的天然回收口。 */
export async function _closeMcpOAuthCallbackServerForTests(): Promise<void> {
  await closeSharedServer()
}

function handleCallbackRequest(req: IncomingMessage, res: ServerResponse): void {
  const port = sharedServerPort ?? REDIRECT_PORT
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end('<h1>Not found</h1>')
    return
  }

  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const pending = state ? pendingCallbacks.get(state) : undefined

  if (!pending) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end('<h1>Unknown or expired authorization session</h1>')
    return
  }

  if (!code) {
    // issue #123 — error 由 provider 提供，裸插进 HTML 会让回调页反射执行脚本
    // （loopback 源上的 XSS）；展示前必须转义。同一个原值还会进 Error 文案流向
    // 终端/TUI，那条路 escapeHtml 管不着，故先在源头净化一次、两个 sink 共用。
    const providerError = sanitizeProviderText(url.searchParams.get('error') ?? 'unknown')
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end(`<h1>Authorization failed: ${escapeHtml(providerError)}</h1>`)
    pending.reject(new Error(`OAuth error: ${providerError}`))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<h1>MCP connected — you can close this tab</h1>')
  pending.resolve(code)
}

/** HTML 转义（issue #123）：回调页只应输出纯文本错误码，provider 提供的字符串
 *  在插值进 HTML 前都必须过这里。 */
function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return s.replace(/[&<>"']/g, c => map[c] ?? c)
}

/** provider 提供的文本（error 码）在进任何 sink 之前的净化：剥掉 C0/C1 控制字符
 *  （ESC 是 ANSI 序列的起点，\r 能在终端里抹掉已写的行），并截断到合理长度。
 *  与 escapeHtml 职责不同、必须叠加：HTML 侧防的是标签/属性逃逸，这里防的是
 *  终端/TUI 侧的序列注入——同一个原值同时流向这两个 sink。 */
function sanitizeProviderText(raw: string, maxLength = 200): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, maxLength)
}

/** Wait for an OAuth callback on the shared redirect server.
 *  Multiple concurrent flows are multiplexed by `state`.
 *  @internal exported for testing only */
export async function serveCallback(
  port: number,
  expectedState: string,
  authUrl: string,
  timeoutMs: number = CALLBACK_TIMEOUT_MS,
): Promise<string> {
  await getOrStartSharedServer(port)
  if (sharedServerClosed) {
    // close 与我们的 await 撞车——不得再登记 pending（否则新超时句柄无人清）。
    throw new Error('OAuth callback server closed')
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      pendingCallbacks.delete(expectedState)
      if (pendingCallbacks.size === 0) {
        closeSharedServer().catch(() => {})
      }
    }

    pendingCallbacks.set(expectedState, {
      resolve: (code) => { cleanup(); resolve(code) },
      reject: (err) => { cleanup(); reject(err) },
      timeout,
    })

    process.stderr.write(`Open this URL to connect MCP:\n${authUrl}\n`)
  })
}

async function postTokenRequest(endpoint: string, form: Record<string, string>): Promise<{
  ok: boolean
  status: number
  text: string
}> {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported OAuth token endpoint protocol: ${url.protocol}`)
  }
  const signal = AbortSignal.timeout(OAUTH_TIMEOUT_MS)
  let abortLookup: () => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    abortLookup = () => reject(signal.reason)
    signal.addEventListener('abort', abortLookup, { once: true })
    if (signal.aborted) abortLookup()
  })
  const resolved = await Promise.race([
    resolveAndAssertPublic(url.hostname, dns.lookup), deadline,
  ]).finally(() => signal.removeEventListener('abort', abortLookup))
  signal.throwIfAborted()
  // 本地回调与 provider 的 token 端点无关：token 端点必须解析到公网地址，且这条
  // **带凭据**的请求无条件把连接钉死在预检过的地址上——RIVET_FETCH_PIN=0 关的是
  // web-fetch 那一套开关，不该给凭据路径留下 DNS 重绑定窗口。
  //
  // 代理是与 pin 独立的第二个维度（同 http-fetch 的模型）：配了代理就只能走
  // ProxyAgent，目标主机名由代理解析、客户端拿不到隧道对端 IP，pin 无从施加
  // （undici 的 ProxyAgent 不读 connect，详见 tools/net/http-fetch.ts 的
  // dispatcherConnectOptions）。代理模式下上方那次 resolveAndAssertPublic 预检
  // 就是唯一一道闸，弱于直连——这是能力边界，不是已修复项。
  const proxyUrl = resolveProxyForUrl(url.href)
  const dispatcher = proxyUrl
    ? new undici.ProxyAgent({ uri: proxyUrl })
    : new undici.Agent({ connect: { lookup: buildPinnedLookup(resolved.address, resolved.family) } })
  try {
    // Match fetch and dispatcher versions; Node's builtin undici can differ.
    const response = await undici.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      dispatcher,
      signal,
    })
    return { ok: response.ok, status: response.status, text: await readBodyCapped(response, MAX_TOKEN_RESPONSE_BYTES) }
  } finally {
    await dispatcher.destroy().catch(() => {})
  }
}

/** 读取响应正文并施加字节上限：先看 content-length（有声明且超限就直接拒绝，不必读流），
 *  再流式累计——没带 content-length 的分块响应同样会被截断。超限即取消流并抛错。
 *  OAuth 总超时由调用方传入的 signal 覆盖到这里：abort 时 reader.read() 会 reject。 */
async function readBodyCapped(response: undici.Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    // 「声明超限」与「实际读到超限」必须给不同文案：两条分支抛同一句话时，任何
    // 断言都分不出是哪条生效——预检是否真的在跑就无法被测试证明（审查发现的
    // 测试强度缺口：一条 declared 用例其实走在流式分支上）。
    const declaredOversize = `OAuth token response declares ${declared} bytes, over the ${maxBytes}-byte limit`
    if (response.body) await response.body.cancel(declaredOversize).catch(() => {})
    throw new Error(declaredOversize)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel(`OAuth token response exceeds ${maxBytes} bytes`).catch(() => {})
        throw new Error(`OAuth token response exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function exchange(
  code: string, codeVerifier: string, redirectUri: string,
  provider: McpOAuthProvider, clientId: string,
): Promise<TokenData> {
  const resp = await postTokenRequest(provider.tokenEndpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  })

  // GitHub returns form-encoded; others return JSON
  const text = resp.text
  let data: Record<string, unknown>
  if (text.startsWith('{')) {
    data = JSON.parse(text) as Record<string, unknown>
  } else {
    // Parse form-encoded (GitHub style: access_token=xxx&scope=...)
    const params = new URLSearchParams(text)
    data = Object.fromEntries(params.entries())
  }

  if (!resp.ok || typeof data.error === 'string') {
    // provider 可控文本（error 字段或正文片段）与回调页的 error 参数同源，且同样流向
    // 终端/TUI（Error.message → 调用方），所以共用 handleCallbackRequest 那道净化：
    // 不净化的话，恶意端点返回的 ESC/C0-C1 序列会在错误展示时注入终端。
    const detail = typeof data.error === 'string' ? data.error : text
    throw new Error(`Token exchange failed (${resp.status}): ${sanitizeProviderText(detail)}`)
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in
    : typeof data.expires_in === 'string' ? Number.parseInt(data.expires_in, 10)
    : 3600

  return {
    accessToken: (data.access_token ?? data.accessToken) as string,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  }
}

async function refreshMcpToken(
  token: TokenData, provider: McpOAuthProvider, clientId: string,
): Promise<TokenData> {
  if (!token.refreshToken) throw new Error('No refresh token — re-authenticate')

  const resp = await postTokenRequest(provider.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token.refreshToken,
  })

  const text = resp.text
  let data: Record<string, unknown>
  if (text.startsWith('{')) {
    data = JSON.parse(text) as Record<string, unknown>
  } else {
    data = Object.fromEntries(new URLSearchParams(text).entries())
  }

  if (!resp.ok) throw new Error(`Token refresh failed (${resp.status})`)

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in
    : typeof data.expires_in === 'string' ? Number.parseInt(data.expires_in, 10)
    : 3600

  return {
    accessToken: (data.access_token ?? data.accessToken) as string,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : token.refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  }
}
