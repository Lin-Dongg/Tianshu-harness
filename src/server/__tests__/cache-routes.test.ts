import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildCacheRoutes } from '../cache-routes.js'
import { findUsagePricing } from '../../utils/deepseek-pricing.js'
import { PROVIDER_PRESETS } from '../../config/provider-presets.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

describe('GET /cache/usage', () => {
  let sessionRoot: string
  let prevSessionDir: string | undefined

  before(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'cache-routes-'))
    const sid = join(sessionRoot, 'session-1')
    mkdirSync(sid, { recursive: true })
    const now = Date.now()
    const lines = [
      { t: now - 1000, model: 'deepseek-chat', input: 10_000, cacheRead: 9_000, cacheCreate: 100, output: 400 },
      { t: now - 2000, model: 'deepseek-chat', input: 10_000, cacheRead: 7_000, cacheCreate: 100, output: 400 },
      { event: 'side_path', kind: 'speculation', t: now - 3000, model: 'deepseek-chat', input: 2_000, cacheRead: 1_000, output: 50 },
      { event: 'reclaim_decision', t: now - 4000, action: 'trim' },
    ]
    writeFileSync(join(sid, 'cache-log.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')

    // RIVET_SESSION_DIR 覆盖 sessionsDir()，让路由扫到临时目录
    prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = sessionRoot
  })

  after(() => {
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(sessionRoot, { recursive: true, force: true })
  })

  const call = (path: string, headers: Record<string, string> = AUTH) =>
    createRouter(buildCacheRoutes({ apiToken: TOKEN, defaultCwd: () => process.cwd() }))('GET', path, {}, headers)

  it('聚合本地 cache-log：主请求命中率只算主请求行，侧路单列', async () => {
    const res = await call('/cache/usage')
    assert.equal(res.status, 200)
    const body = res.body as {
      scope: string
      windowDays: number
      days: Array<{ date: string; requests: number }>
      totals: { requests: number; sidePathRequests: number; input: number; hitRate: number | null }
      models: Array<{ model: string }>
      scannedFiles: number
    }
    assert.equal(body.scope, 'project')
    assert.equal(body.windowDays, 30)
    // days 是按天明细数组（不是标量窗口天数）
    assert.equal(body.days.length, 1)
    assert.equal(body.totals.requests, 2)
    assert.equal(body.totals.sidePathRequests, 1)
    // (9000+7000)/(10000+10000) = 80%
    assert.equal(body.totals.hitRate, 80)
    assert.equal(body.models[0]!.model, 'deepseek-chat')
    assert.equal(body.scannedFiles, 1)
  })

  it('days 参数生效并夹到上限 366', async () => {
    const res = await call('/cache/usage?days=7')
    assert.equal((res.body as { windowDays: number }).windowDays, 7)
    const capped = await call('/cache/usage?days=9999')
    assert.equal((capped.body as { windowDays: number }).windowDays, 366)
  })

  it('还原 90 天上限会使年度查询断言失败（隔离变体）', async () => {
    const original = readFileSync(new URL('../cache-routes.ts', import.meta.url), 'utf8')
    const mutant = original.replace('const MAX_DAYS = 366', 'const MAX_DAYS = 90')
    assert.notEqual(mutant, original)
    const module = { exports: {} as { buildCacheRoutes: typeof buildCacheRoutes } }
    runInNewContext(transformSync(mutant, { loader: 'ts', format: 'cjs' }).code, {
      module, exports: module.exports,
      require: () => ({ isAuthorizedRequest: () => true, sessionsDir: () => '/fixture',
        loadConfig: () => ({ provider: { providers: {}, default: 'fixture' } }),
        aggregateCacheUsage: async ({ days }: { days: number }) => ({ windowDays: days }),
      }),
    })
    const route = module.exports.buildCacheRoutes({ defaultCwd: () => '/fixture' })['GET /cache/usage']!
    const result = await route({}, { days: '366', scope: 'all' }, {})
    assert.throws(() => assert.equal((result.body as { windowDays: number }).windowDays, 366))
  })

  it('非法 days 报 400 而不是静默当默认值', async () => {
    for (const days of ['0', '-3', 'abc']) {
      const res = await call(`/cache/usage?days=${days}`)
      assert.equal(res.status, 400, `days=${days}`)
    }
  })

  it('scope=all 扫全部项目根目录', async () => {
    const res = await call('/cache/usage?scope=all')
    assert.equal(res.status, 200)
    assert.equal((res.body as { scope: string }).scope, 'all')
  })

  it('rejects unauthorized requests', async () => {
    const res = await call('/cache/usage', {})
    assert.equal(res.status, 401)
  })
})


it('actual cache route forwards per-request time to the official pricing consumer', async () => {
  const original = readFileSync(new URL('../cache-routes.ts', import.meta.url), 'utf8')
  const execute = async (source: string) => {
    const module = { exports: {} as { buildCacheRoutes: typeof buildCacheRoutes } }
    runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
      module, exports: module.exports, Date,
      require: () => ({ isAuthorizedRequest: () => true, sessionsDir: () => '/fixture', findUsagePricing,
        loadConfig: () => ({ provider: { providers: { official: PROVIDER_PRESETS.deepseek.provider }, default: 'official' } }),
        aggregateCacheUsage: async ({ resolvePricing }: { resolvePricing: (model: string, provider: string | undefined, timestamp: number) => { output: number } }) => ({
          outputs: ['2026-09-28T01:00:00Z', '2026-09-28T04:00:00Z'].map(time => resolvePricing('deepseek-flash', undefined, Date.parse(time)).output),
        }),
      }),
    })
    const route = module.exports.buildCacheRoutes({ defaultCwd: () => '/fixture' })['GET /cache/usage']!
    return (await route({}, {}, {})).body as { outputs: number[] }
  }
  assert.deepEqual((await execute(original)).outputs, [8, 4])
  const old = original.replace('timestamp ?? Date.now()', 'Date.now()')
  assert.notEqual(old, original)
  const result = await execute(old)
  assert.throws(() => assert.deepEqual(result.outputs, [8, 4]))
})
