/**
 * 天枢账号路由——桌面端账号页经 sidecar 走 device flow。
 *
 * ## 为什么要有这一层
 * device flow 的实现只有一份（`src/auth/account.ts`），但桌面端的渲染进程
 * 拿不到它：那个模块依赖 `process.env`、`TokenStore` 文件落盘和 Node 的 fetch，
 * 是纯 Node 模块，WebView 里 import 不了。侧车 HTTP 是既定的跨端通道
 * （`rivetFetch` 自带 Bearer token），这里把账号能力挂上去。
 *
 * ## 两条不能破的线
 * 1. **凭据不出 sidecar**。`POST /account/poll` 拿到 `approved` 时由服务端直接
 *    落盘 `<RIVET_HOME>/account.json`，响应体只回状态——accessToken 不进
 *    WebView 的内存与 devtools。落盘位置与 CLI/TUI 共用，所以桌面端登录完，
 *    终端里的 `/status` 也认。
 * 2. **轮询是单次 check**，不是 `pollForAccountToken` 那个 5 分钟长循环：
 *    前端 `rivetFetch` 默认 15s 超时（`desktop/src/runtime/client.ts`），
 *    长循环会被切断。节奏由前端按 `pollInterval` 掌握。
 *
 * ## 代理
 * 侧车进程**不装配全局 dispatcher**：`setupHttpProxy()` 只被交互式会话的
 * `bootstrapInteractiveSession` 调用，`src/server/serve.ts` 有自己的入口不经过它。
 * 不管的话，配了代理的用户（官网反代正是为他们存在）会卡在「等待授权」转圈。
 * 所以这里在构建期解析一次代理并注入带 dispatcher 的 fetch。
 */
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
import { resolveProxyForUrl } from '../tools/net/proxy-resolver.js'
import { rivetHome } from '../config/paths.js'
import { accountDeviceFingerprint } from '../auth/account-device.js'
import * as accountModule from '../auth/account.js'
import type {
  AccountProfile,
  AccountProfileSnapshot,
  DeviceCreateResult,
  DevicePollResult,
  FetchInjection,
  FetchLike,
  RequestDeviceCodeOpts,
  StellarIdentity,
} from '../auth/account.js'
import type { TokenStore, TokenData } from '../auth/token-store.js'

/**
 * 路由需要的那部分账号能力。
 *
 * 抽成接口是为了单测能注入桩（网络面全假），而**落盘面在测试里用真实实现**——
 * 「凭据进文件、不进响应体」这条不变量只有真实磁盘能证。
 */
export interface AccountApi {
  cancelDeviceCode?(deviceCode: string, opts?: FetchInjection): Promise<boolean>
  revokeAccountSession?(accessToken: string, opts?: FetchInjection): Promise<boolean>
  requestDeviceCode(opts: RequestDeviceCodeOpts): Promise<DeviceCreateResult>
  checkDeviceOnce(deviceCode: string, opts?: FetchInjection): Promise<DevicePollResult>
  fetchAccountProfile(accessToken: string, opts?: FetchInjection): Promise<AccountProfile | null>
  refreshAccountToken?(refreshToken: string, opts?: FetchInjection): Promise<DevicePollResult | null>
  accountStore(rivetHome: string): TokenStore
  saveAccountToken(store: TokenStore, poll: DevicePollResult): TokenData
  /** 读本人星籍（PostgREST + 用户 JWT，RLS 收口）。失败回 null，不抛。 */
  fetchStellarIdentity(accessToken: string, opts?: FetchInjection): Promise<StellarIdentity | null>
  saveAccountIdentity(store: TokenStore, token: TokenData, identity: StellarIdentity): TokenData
  cachedAccountIdentity(token: TokenData | null): { identity: StellarIdentity; fetchedAt: number } | null
  isAccountIdentityStale(fetchedAt: number, now?: number): boolean
  /** 账号资料（头像 + 创始铭牌）。与星籍同通道同口径：失败回 null，不抛。 */
  fetchAccountProfileSnapshot(accessToken: string, opts?: FetchInjection): Promise<AccountProfileSnapshot | null>
  saveAccountProfile(store: TokenStore, token: TokenData, profile: AccountProfileSnapshot, now?: number): TokenData
  cachedAccountProfile(token: TokenData | null): AccountProfileSnapshot | null
  /** 官网星籍页 URL（「在官网查看」按钮的目标）。 */
  accountIdentityUrl(): string
  /** 官网账号与授权页 URL（个人中心权益面板「在官网查看账号与授权」的目标）。 */
  accountManageUrl(): string
}

export interface AccountRoutesDeps {
  /** 共享 Bearer token；缺省即 fail-closed（全 401）。 */
  apiToken?: string
  /** 账号凭据落盘根目录（与 CLI/TUI 同一个 RIVET_HOME）。 */
  rivetHome: string
  /** 注入点：默认走 `src/auth/account.ts` 的真实实现。 */
  account?: AccountApi
  /** `config.network.proxy`；未设时回退环境变量 / 系统代理。 */
  proxyUrl?: string
  /** `config.network.noProxy`。 */
  noProxy?: string
}

/** 按代理 URL 缓存 dispatcher——每请求新建会漏连接池。 */
const agents = new Map<string, ProxyAgent>()

function dispatcherFor(uri: string): ProxyAgent {
  let agent = agents.get(uri)
  if (!agent) {
    agent = new ProxyAgent({ uri })
    agents.set(uri, agent)
  }
  return agent
}

/**
 * 构建带代理 dispatcher 的 fetch；无代理时返回 undefined（调用方回退全局 fetch）。
 *
 * 目标 URL 只用于代理解析（NO_PROXY 匹配、协议选择），不参与请求本身——
 * 真正的请求 URL 由 `src/auth/account.ts` 按 `accountApiBase()` 拼。
 */
function buildProxyFetch(deps: AccountRoutesDeps): FetchLike | undefined {
  const target = accountModule.accountApiBase()
  const proxyUrl = resolveProxyForUrl(target, { proxyUrl: deps.proxyUrl, noProxy: deps.noProxy })
  if (!proxyUrl) return undefined
  const dispatcher = dispatcherFor(proxyUrl)
  // undici 的 fetch 接受 dispatcher，全局 fetch 的类型里没有这个字段——
  // 这里是有意的类型抹平，运行时形状一致（status/ok/json 都在）。
  return (async (input: unknown, init?: unknown) =>
    undiciFetch(input as string, {
      ...((init ?? {}) as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as FetchLike
}

function defaultAccountApi(): AccountApi {
  return {
    requestDeviceCode: accountModule.requestDeviceCode,
    cancelDeviceCode: accountModule.cancelDeviceCode,
    revokeAccountSession: accountModule.revokeAccountSession,
    checkDeviceOnce: accountModule.checkDeviceOnce,
    fetchAccountProfile: accountModule.fetchAccountProfile,
    refreshAccountToken: accountModule.refreshAccountToken,
    accountStore: accountModule.accountStore,
    saveAccountToken: accountModule.saveAccountToken,
    fetchStellarIdentity: accountModule.fetchStellarIdentity,
    saveAccountIdentity: accountModule.saveAccountIdentity,
    cachedAccountIdentity: accountModule.cachedAccountIdentity,
    fetchAccountProfileSnapshot: accountModule.fetchAccountProfileSnapshot,
    saveAccountProfile: accountModule.saveAccountProfile,
    cachedAccountProfile: accountModule.cachedAccountProfile,
    isAccountIdentityStale: accountModule.isAccountIdentityStale,
    accountIdentityUrl: accountModule.accountIdentityUrl,
    accountManageUrl: accountModule.accountManageUrl,
  }
}

export function buildAccountRoutes(deps: AccountRoutesDeps): Record<string, RouteHandler> {
  const api = deps.account ?? defaultAccountApi()
  // 代理在构建期解析一次：配置在进程生命周期内不变，而 macOS 的解析要起
  // `scutil --proxy` 子进程，逐请求跑是白付。
  const fetchImpl = buildProxyFetch(deps)
  // 与 /status、/abort 同一份认证实现（routes.ts 的 withAuth）——
  // 认证规则漂移出第二份就是安全洞。
  const guard = (handler: RouteHandler): RouteHandler => withAuth(handler, deps.apiToken)

  let activeDeviceCode: string | undefined
  const cancelRemote = async () => {
    const code = activeDeviceCode
    activeDeviceCode = undefined
    if (!code) return true
    try { return await api.cancelDeviceCode?.(code, { fetchImpl }) ?? false } catch { return false }
  }
  let generation = 0
  let refreshJob: { accessToken: string; promise: Promise<boolean> } | undefined
  let lastRefresh: { accessToken: string; fromToken?: string; at: number; ok: boolean; partial?: boolean } | undefined
  const polls = new Map<string, { generation: number; expiresAt: number; promise: Promise<Awaited<ReturnType<RouteHandler>>> }>()

  // Independent requests merge into the latest disk snapshot. Logout or another login
  // invalidates every pending write; a missing category never erases its cached data.
  const refreshAccount = (store: TokenStore, accessToken: string, force = false): Promise<boolean> => {
    if (refreshJob?.accessToken === accessToken) return refreshJob.promise
    if (!force && lastRefresh?.accessToken === accessToken && Date.now() - lastRefresh.at < 30_000) {
      return Promise.resolve(lastRefresh.ok)
    }
    const started = generation
    let activeToken = accessToken
    const current = () => {
      const fresh = store.load()
      return generation === started && fresh?.accessToken === activeToken ? fresh : null
    }
    const identityTask = async () => {
      const cached = api.cachedAccountIdentity(store.load())
      if (!force && !api.isAccountIdentityStale(cached?.fetchedAt ?? 0)) return true
      const identity = await api.fetchStellarIdentity(activeToken, { fetchImpl })
      const fresh = current()
      if (!identity || !fresh) return false
      api.saveAccountIdentity(store, fresh, identity)
      return true
    }
    const profileTask = async () => {
      const previous = api.cachedAccountProfile(store.load())
      if (!force && !previous?.unconfirmed?.length && !api.isAccountIdentityStale(previous?.fetchedAt ?? 0)) return true
      const profile = await api.fetchAccountProfileSnapshot(activeToken, { fetchImpl })
      const fresh = current()
      if (!profile || !fresh) return false
      const cached = api.cachedAccountProfile(fresh)
      api.saveAccountProfile(store, fresh, { ...profile, founding: profile.unconfirmed?.includes('founding') ? profile.founding ?? cached?.founding ?? null : profile.founding, avatarUrl: profile.unconfirmed?.includes('avatar') ? cached?.avatarUrl ?? null : profile.avatarUrl, account: cached?.account })
      return !profile.unconfirmed?.length
    }
    const contactTask = async () => {
      const previous = api.cachedAccountProfile(store.load())
      if (!force && previous?.account && !api.isAccountIdentityStale(previous.fetchedAt)) return true
      const account = await api.fetchAccountProfile(activeToken, { fetchImpl })
      const fresh = current()
      if (!account || !fresh) return false
      const cached = api.cachedAccountProfile(fresh)
      api.saveAccountProfile(store, fresh, { avatarUrl: cached?.avatarUrl ?? null, founding: cached?.founding ?? null,
        fetchedAt: Date.now(), account, unconfirmed: cached?.unconfirmed ?? (cached ? undefined : ['avatar', 'founding']) })
      return true
    }
    const promise = (async () => {
      const before = current()
      if (!before) return false
      if (before.expiresAt <= Date.now() + 60_000 && before.refreshToken && api.refreshAccountToken) {
        const rotated = await api.refreshAccountToken(before.refreshToken, { fetchImpl })
        const fresh = current()
        if (!rotated?.accessToken || !fresh) {
          if (!fresh && rotated?.accessToken) { try { await api.revokeAccountSession?.(rotated.accessToken, { fetchImpl }) } catch {} }
          if (fresh) lastRefresh = { accessToken: activeToken, at: Date.now(), ok: false }
          return false
        }
        store.save({ ...fresh, accessToken: rotated.accessToken, refreshToken: rotated.refreshToken,
          expiresAt: Date.now() + (rotated.expiresIn ?? 3600) * 1000 })
        activeToken = rotated.accessToken
        if (refreshJob?.accessToken === accessToken) refreshJob.accessToken = activeToken
      }
      const results = await Promise.allSettled([identityTask(), profileTask(), contactTask()])
      const succeeded = results.map(result => result.status === 'fulfilled' && result.value)
      const ok = succeeded.every(Boolean)
      if (current()) lastRefresh = { accessToken: activeToken, fromToken: accessToken, at: Date.now(), ok, partial: !ok && succeeded.some(Boolean) }
      return results[0].status === 'fulfilled' && results[0].value
    })().catch(() => {
      if (current()) lastRefresh = { accessToken: activeToken, at: Date.now(), ok: false }
      return false
    }).finally(() => {
      if (refreshJob?.promise === promise) refreshJob = undefined
    })
    refreshJob = { accessToken, promise }
    return promise
  }

  const pollOnce = async (deviceCode: string, started: number) => {
    let poll: DevicePollResult
    try {
      poll = await api.checkDeviceOnce(deviceCode, { fetchImpl })
    } catch {
      return { status: 502, body: { error: 'device check temporarily unavailable' } }
    }
    if (started !== generation) {
      if (poll.accessToken) { try { await api.revokeAccountSession?.(poll.accessToken, { fetchImpl }) } catch {} }
      return { status: 200, body: { status: 'expired' } }
    }
    if (poll.status !== 'approved') return { status: 200, body: { status: poll.status } }
    const store = api.accountStore(deps.rivetHome)
    try {
      const saved = api.saveAccountToken(store, poll)
      void refreshAccount(store, saved.accessToken, true)
    } catch {
      return { status: 500, body: { error: 'could not save account login' } }
    }
    if (activeDeviceCode === deviceCode) activeDeviceCode = undefined
    // Approval acknowledges durable credentials, never optional network metadata.
    return { status: 200, body: { status: 'approved' } }
  }

  return {
    'POST /account/device': guard(async body => {
      const started = ++generation
      polls.clear()
      await cancelRemote()
      const input = (body ?? {}) as { deviceName?: unknown; deviceFingerprint?: unknown }
      const deviceName = typeof input.deviceName === 'string' && input.deviceName ? input.deviceName : undefined
      let deviceFingerprint: string
      try { deviceFingerprint = accountDeviceFingerprint(deps.rivetHome, input.deviceFingerprint) }
      catch { return { status: 400, body: { error: 'device identity unavailable or invalid' } } }
      try {
        const created = await api.requestDeviceCode({ deviceName, deviceFingerprint, fetchImpl })
        if (started !== generation) {
          try { await api.cancelDeviceCode?.(created.deviceCode, { fetchImpl }) } catch {}
          return { status: 409, body: { error: 'authorization superseded' } }
        }
        activeDeviceCode = created.deviceCode
        return { status: 200, body: created }
      } catch {
        return { status: 502, body: { error: 'device authorization temporarily unavailable' } }
      }
    }),
    'POST /account/poll': guard(async body => {
      const input = (body ?? {}) as { deviceCode?: unknown }
      const deviceCode = typeof input.deviceCode === 'string' ? input.deviceCode.trim() : ''
      if (!deviceCode) return { status: 400, body: { error: 'deviceCode is required' } }
      for (const [key, receipt] of polls) {
        if (receipt.expiresAt <= Date.now() || receipt.generation !== generation) polls.delete(key)
      }
      const previous = polls.get(deviceCode)
      if (previous) return previous.promise
      if (polls.size >= 128) return { status: 429, body: { error: 'too many authorization attempts' } }
      const receipt = { generation, expiresAt: Date.now() + 300_000, promise: pollOnce(deviceCode, generation) }
      polls.set(deviceCode, receipt)
      const result = await receipt.promise
      // Only retain approved receipts, so a lost response or duplicate request can
      // recover without consuming the one-use device grant a second time.
      if ((result.body as { status?: string })?.status !== 'approved' && polls.get(deviceCode) === receipt) polls.delete(deviceCode)
      return result
    }),
    'GET /account/status': guard(async () => {
      const store = api.accountStore(deps.rivetHome)
      const token = store.load()
      if (!token?.accessToken) return { status: 200, body: {
        loggedIn: false, email: null, userId: null, expiresAt: null, stellarId: null,
        primaryDomain: null, title: null, avatarUrl: null, founding: null,
      } }
      const cached = api.cachedAccountIdentity(token)
      const profile = api.cachedAccountProfile(token)
      if (token.expiresAt <= Date.now() + 60_000 || profile?.unconfirmed?.length || api.isAccountIdentityStale(cached?.fetchedAt ?? 0) || api.isAccountIdentityStale(profile?.fetchedAt ?? 0) || !profile?.account) {
        void refreshAccount(store, token.accessToken)
      }
      return { status: 200, body: {
        loggedIn: true, email: profile?.account?.email ?? null, userId: accountModule.jwtSubject(token.accessToken) ?? profile?.account?.userId ?? null,
        username: profile?.account?.username ?? null,
        displayName: profile?.account?.displayName ?? null, joinedAt: profile?.account?.joinedAt ?? null,
        expiresAt: token.expiresAt, stellarId: cached?.identity.stellarId ?? null,
        primaryDomain: cached?.identity.primaryDomain ?? null, title: cached?.identity.title ?? null,
        identityFetchedAt: cached?.fetchedAt || null, identityUrl: api.accountIdentityUrl(), manageUrl: api.accountManageUrl(),
        avatarUrl: profile?.avatarUrl ?? null, founding: profile?.founding ?? null, profileFetchedAt: profile?.fetchedAt || null,
        profileConfirmed: Boolean(profile && !profile.unconfirmed?.includes('founding')),
        syncState: refreshJob?.accessToken === token.accessToken ? 'syncing' : lastRefresh?.accessToken === token.accessToken && !lastRefresh.ok ? lastRefresh.partial ? 'partial' : 'offline' : 'cached',
      } }
    }),
    'POST /account/identity/refresh': guard(async () => {
      const store = api.accountStore(deps.rivetHome)
      const token = store.load()
      if (!token?.accessToken) return { status: 401, body: { error: 'not signed in' } }
      const started = generation
      const refreshed = await refreshAccount(store, token.accessToken, true)
      const fresh = store.load()
      const renewed = lastRefresh?.fromToken === token.accessToken && lastRefresh.accessToken === fresh?.accessToken
      if (started !== generation || (fresh?.accessToken !== token.accessToken && !renewed)) return { status: 200, body: { refreshed: false, stellarId: null, primaryDomain: null, title: null } }
      const identity = api.cachedAccountIdentity(fresh)?.identity
      return { status: 200, body: { refreshed, complete: lastRefresh?.accessToken === fresh?.accessToken && lastRefresh.ok, stellarId: identity?.stellarId ?? null,
        primaryDomain: identity?.primaryDomain ?? null, title: identity?.title ?? null } }
    }),
    'POST /account/cancel': guard(async () => {
      generation++
      polls.clear()
      const remoteCancelled = await cancelRemote()
      return { status: 200, body: { ok: true, remoteCancelled } }
    }),
    'POST /account/logout': guard(async () => {
      generation++
      polls.clear()
      refreshJob = undefined
      lastRefresh = undefined
      const store = api.accountStore(deps.rivetHome)
      const credential = store.load()?.accessToken
      store.clear()
      await cancelRemote()
      let remoteRevoked = !credential
      try { if (credential) remoteRevoked = await api.revokeAccountSession?.(credential, { fetchImpl }) ?? false } catch {}
      return { status: 200, body: { ok: true, remoteRevoked } }
    }),
  }
}

/**
 * serve.ts 的装配入口：配置与 RIVET_HOME 的解析都收在这一侧。
 *
 * 存在的理由是 `src/server/serve.ts` 是行数棘轮点名的巨石（只降不升，见
 * `scripts/source-budgets.manifest.json`），调用点因此只剩一行接线——与
 * `/project/trust` 路由当初的处置同构（主体在 trust-api.ts，serve 只接线）。
 *
 * config 用结构化类型而非 RivetConfig：这里只读 `network` 两个字段，避免为
 * 一个接线函数把整个配置 schema 拉进依赖。
 */
export function buildAccountRoutesFor(
  apiToken: string | undefined,
  config: { network?: { proxy?: string; noProxy?: string } },
): Record<string, RouteHandler> {
  return buildAccountRoutes({
    apiToken,
    rivetHome: rivetHome(),
    proxyUrl: config.network?.proxy,
    noProxy: config.network?.noProxy,
  })
}
