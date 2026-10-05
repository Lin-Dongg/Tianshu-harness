/**
 * P0-5 —— HTTP 路由异常兜底。
 *
 * 现场：某测试临时目录被删后仍在真实会话库（21 个 fac-* 会话），桌面端点
 * 「应用模板」→ POST /project-templates/apply → ENOENT 穿透路由 → createServer
 * 回调的 async 函数返回 rejected promise → 无人 catch → sidecar 整进程退出。
 *
 * 契约：路由 handler 抛错（同步 throw 或 reject）都由 createServer 回调兜住——
 *   - 未发响应头 → 500 JSON，且**下一个请求照常响应**（进程不死）；
 *   - 已开始流式输出 → 断开该连接，不再写 500；
 *   - 错误落 serverLogger.error（含 errorContext）。
 * 不加 process 级 unhandledRejection 吞并——路由外的异常仍应暴露。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../index.js'
import { resetServerLogger, setServerLogger } from '../logger.js'
import type { RouteHandler } from '../index.js'

const TOKEN = 'http-error-fallback-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** 所有请求带超时：缺陷未修时服务端不会应答，无超时会挂住整个测试进程。 */
const get = (url: string) => fetch(url, { headers: AUTH, signal: AbortSignal.timeout(5000) })

async function closeServer(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
  server.closeIdleConnections()
  await new Promise<void>((r) => server.close(() => r()))
}

test('路由同步抛错 → 500 JSON，且进程不死、下一请求照常', async () => {
  const logs: Array<{ message: string; context?: Record<string, unknown> }> = []
  setServerLogger({
    info: () => {},
    warn: () => {},
    error: (message, context) => logs.push({ message, context }),
  })
  const routes: Record<string, RouteHandler> = {
    'GET /boom': () => { throw new Error('route exploded') },
    'GET /ok': () => ({ status: 200, body: { ok: true } }),
  }
  const server = await startServer(0, routes, TOKEN)
  try {
    const base = `http://127.0.0.1:${server.port}`

    const bad = await get(`${base}/boom`)
    assert.equal(bad.status, 500, '抛错的路由必须回 500')
    assert.deepEqual(await bad.json(), { error: 'Internal server error' })

    const good = await get(`${base}/ok`)
    assert.equal(good.status, 200, '路由抛错后下一个请求必须照常响应')
    assert.deepEqual(await good.json(), { ok: true })

    assert.ok(
      logs.some((l) => l.message.includes('route exploded') || JSON.stringify(l.context ?? {}).includes('route exploded')),
      `错误必须落 serverLogger.error 且带 errorContext: ${JSON.stringify(logs)}`,
    )
  } finally {
    resetServerLogger()
    await closeServer(server)
  }
})

test('路由异步 reject → 同样被兜住（500 / 下一请求正常）', async () => {
  const server = await startServer(0, {
    'GET /reject': async () => { throw new Error('async boom') },
    'GET /ping': () => ({ status: 200, body: 'pong' }),
  }, TOKEN)
  try {
    const base = `http://127.0.0.1:${server.port}`
    const bad = await get(`${base}/reject`)
    assert.equal(bad.status, 500)
    const good = await get(`${base}/ping`)
    assert.equal(good.status, 200)
  } finally {
    await closeServer(server)
  }
})

test('已开始流式输出时不写 500，只断开该连接', async () => {
  const server = await startServer(0, {
    'GET /stream-boom': (_body, _params, _headers, res) => {
      // 模拟 SSE/流式路径：响应头已发出后才抛错
      res!.writeHead(200, { 'Content-Type': 'text/plain' })
      res!.write('partial')
      throw new Error('boom after headers sent')
    },
    'GET /ok': () => ({ status: 200, body: { ok: true } }),
  }, TOKEN)
  try {
    const base = `http://127.0.0.1:${server.port}`
    const outcome = await get(`${base}/stream-boom`)
      .then(async (r) => {
        try { return { status: r.status, text: await r.text() } }
        catch { return { status: r.status, text: '<aborted>' } }
      })
      .catch(() => ({ status: 0, text: '<fetch-rejected>' }))
    assert.notEqual(outcome.status, 500, '响应头已发出，不得再写 500')

    const good = await get(`${base}/ok`)
    assert.equal(good.status, 200, '断开单个连接不得影响后续请求')
  } finally {
    await closeServer(server)
  }
})
