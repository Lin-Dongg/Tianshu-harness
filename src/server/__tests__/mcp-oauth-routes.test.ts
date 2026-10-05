/**
 * /mcp/* OAuth 路由契约（2026-10-04 GitHub MCP 桌面端无法启用的修复）：
 *
 *  - POST /mcp/servers/:id/oauth/start **立即返回 authUrl**，不阻塞等回调——
 *    旧实现 await 整个流程（serveCallback 只把 URL 写 sidecar stderr），
 *    桌面端用户永远看不到该开哪个链接，OAuth 从桌面端不可达。
 *  - 在途流程状态经 GET oauth/status 暴露（pending / error），供前端轮询。
 *  - GET /mcp/presets 给 oauth 预设投影 clientIdHelp（providers.ts 单源）。
 *  - 负路径（缺 clientId / 未知服务器 / 非 oauth 服务器）不进正路径。
 *
 * 端口隔离：RIVET_OAUTH_PORT 必须在 connector 模块加载前设定（模块级常量），
 * 故全部走动态 import。正路径会真起回环监听——用独立高端口，套件 force-exit
 * 时随进程回收（与 request-security.test.ts 同纪律）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const OAUTH_PORT = '17498'

type Router = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>

describe('/mcp OAuth routes', () => {
  const prevHome = process.env.RIVET_HOME
  const prevPort = process.env.RIVET_OAUTH_PORT
  let home: string
  let router: Router

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'mcp-oauth-routes-'))
    process.env.RIVET_HOME = home
    process.env.RIVET_OAUTH_PORT = OAUTH_PORT
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      mcp: {
        servers: {
          github: {
            url: 'https://api.githubcopilot.com/mcp/',
            auth: { type: 'oauth', provider: 'github', scopes: ['repo', 'read:org'] },
          },
          plain: { command: 'npx', args: ['-y', 'some-server'] },
        },
      },
    }, null, 2) + '\n')
    const { createRouter } = await import('../index.js')
    const { buildMcpRoutes } = await import('../mcp-api.js')
    router = createRouter(buildMcpRoutes(() => null, TOKEN)) as Router
  })

  after(async () => {
    // 正路径留下的在途流程（回环监听 + 5 分钟超时）会吊住事件循环——显式回收。
    const { _closeMcpOAuthCallbackServerForTests } = await import('../../mcp/oauth/connector.js')
    await _closeMcpOAuthCallbackServerForTests()
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevPort === undefined) delete process.env.RIVET_OAUTH_PORT
    else process.env.RIVET_OAUTH_PORT = prevPort
    rmSync(home, { recursive: true, force: true })
  })

  it('presets：oauth 预设附带 clientIdHelp（providers.ts 注册指引的投影）', async () => {
    const res = await router('GET', '/mcp/presets', {}, AUTH)
    assert.equal(res.status, 200)
    const gh = (res.body as { presets: { id: string; clientIdHelp?: string }[] })
      .presets.find(p => p.id === 'github')
    assert.ok(gh, 'github 预设应在目录里')
    assert.ok(gh!.clientIdHelp?.includes('OAuth Apps'), `clientIdHelp 缺失或未投影: ${gh!.clientIdHelp}`)
  })

  it('oauth/start：缺 clientId → 400', async () => {
    const res = await router('POST', '/mcp/servers/github/oauth/start', {}, AUTH)
    assert.equal(res.status, 400)
  })

  it('oauth/start：未知服务器 → 404', async () => {
    const res = await router('POST', '/mcp/servers/no-such/oauth/start', { clientId: 'x' }, AUTH)
    assert.equal(res.status, 404)
  })

  it('oauth/start：非 oauth 服务器 → 400', async () => {
    const res = await router('POST', '/mcp/servers/plain/oauth/start', { clientId: 'x' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('oauth/start 立即返回 authUrl（含 client_id/redirect_uri/state/scope），status 转 pending', async () => {
    const res = await router('POST', '/mcp/servers/github/oauth/start', { clientId: 'fixture-client' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; authUrl?: string }
    // 旧实现永远走不到这里——它阻塞到回调完成且响应里没有 authUrl 字段。
    assert.ok(body.authUrl, '响应必须带 authUrl（前端开浏览器用）')
    assert.ok(body.authUrl!.startsWith('https://github.com/login/oauth/authorize'), body.authUrl)
    assert.ok(body.authUrl!.includes('client_id=fixture-client'), body.authUrl)
    assert.ok(body.authUrl!.includes('redirect_uri='), body.authUrl)
    assert.ok(body.authUrl!.includes(`localhost%3A${OAUTH_PORT}`) || body.authUrl!.includes(`localhost:${OAUTH_PORT}`), body.authUrl)
    assert.ok(body.authUrl!.includes('state='), body.authUrl)
    assert.ok(body.authUrl!.includes('repo'), body.authUrl)

    const st = await router('GET', '/mcp/servers/github/oauth/status', {}, AUTH)
    assert.equal(st.status, 200)
    const sb = st.body as { connected: boolean; pending: boolean }
    assert.equal(sb.connected, false, 'token 未落盘前不得报 connected')
    assert.equal(sb.pending, true, 'start 之后应有在途流程')
  })
})
