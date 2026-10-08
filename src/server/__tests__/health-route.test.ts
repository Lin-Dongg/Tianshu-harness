import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildHealthRoute } from '../health-route.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return new Promise(() => {}) }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup() {
  const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const router = createRouter(buildHealthRoute(manager, Date.now() - 1000, '9.9.9', TOKEN))
  return { manager, router }
}

test('GET /health is intentionally open (desktop monitor probes without token)', async () => {
  const { router } = setup()
  const res = await router('GET', '/health', {}, {})
  assert.equal(res.status, 200)
  assert.equal((res.body as { ok: boolean }).ok, true)
  assert.deepEqual(res.body, { ok: true }, 'anonymous probes must not expose a version fingerprint')
})

test('GET /health reports version, uptime and counts', async () => {
  const { manager, router } = setup()
  manager.createSession({})
  manager.createSession({ prompt: 'go' })
  const res = await router('GET', '/health', {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { ok: boolean; version: string; uptimeMs: number; sessionCount: number; runningCount: number; registryOk: boolean }
  assert.equal(body.ok, true)
  assert.equal(body.version, '9.9.9')
  assert.ok(body.uptimeMs >= 1000)
  assert.equal(body.sessionCount, 2)
  assert.equal(body.runningCount, 1)
  // registryReady omitted → reports healthy (single-session / test default)
  assert.equal(body.registryOk, true)
})

test('GET /health 自报 capabilities —— 前端据此判断能力，而不是靠版本号猜（issue #266）', async () => {
  const { router } = setup()
  const body = (await router('GET', '/health', {}, AUTH)).body as { capabilities?: { schedulePatch?: boolean } }
  assert.equal(body.capabilities?.schedulePatch, true, '支持 PATCH /schedule/:id 的运行时要自报')

  // 匿名探测（无 token）保持最小体：rich fields 是「用户正在跑 agent」的活动侧信道，
  // 能力表虽然不敏感，但也没有理由扩大无鉴权响应面。
  const anon = (await router('GET', '/health', {}, {})).body as Record<string, unknown>
  assert.ok(!('capabilities' in anon), 'anonymous probe stays minimal')
})

test('GET /health surfaces registry readiness when a probe is wired', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  let ready = false
  let configured = false
  const router = createRouter(
    buildHealthRoute(manager, Date.now(), '9.9.9', TOKEN, () => ready, () => configured),
  )
  const pending = (await router('GET', '/health', {}, AUTH)).body as { ok: boolean; registryOk: boolean; configured: boolean }
  assert.equal(pending.registryOk, false)
  assert.equal(pending.configured, false)
  assert.equal(pending.ok, false)
  ready = true
  const configuredReady = (await router('GET', '/health', {}, AUTH)).body as { ok: boolean; registryOk: boolean; configured: boolean }
  assert.equal(configuredReady.registryOk, true)
  assert.equal(configuredReady.configured, false)
  assert.equal(configuredReady.ok, false)
  configured = true
  const resolved = (await router('GET', '/health', {}, AUTH)).body as { ok: boolean; registryOk: boolean; configured: boolean }
  assert.equal(resolved.registryOk, true)
  assert.equal(resolved.configured, true)
  assert.equal(resolved.ok, true)
})

test('GET /health includes loop-lag fields when a monitor is wired, omits otherwise', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const withLag = createRouter(
    buildHealthRoute(manager, Date.now(), '9.9.9', TOKEN, undefined, undefined,
      () => ({ p99Ms: 42.5, maxMs: 1200 })),
  )
  const body = (await withLag('GET', '/health', {}, AUTH)).body as Record<string, unknown>
  assert.equal(body.loopLagP99Ms, 42.5)
  assert.equal(body.loopLagMaxMs, 1200)

  const withoutLag = createRouter(buildHealthRoute(manager, Date.now(), '9.9.9', TOKEN))
  const plain = (await withoutLag('GET', '/health', {}, AUTH)).body as Record<string, unknown>
  assert.ok(!('loopLagP99Ms' in plain), 'no monitor wired → fields absent')
})

test('LoopHealthMonitor shares a sampled stall window across consumers', async () => {
  const { LoopHealthMonitor } = await import('../loop-health.js')
  const mon = new LoopHealthMonitor()
  mon.start()
  try {
    // Let the histogram take a few baseline samples, then stall the loop.
    await new Promise((r) => setTimeout(r, 50))
    const stallUntil = Date.now() + 120
    while (Date.now() < stallUntil) { /* synchronous stall */ }
    await new Promise((r) => setTimeout(r, 1100))
    const first = mon.snapshot()
    assert.ok(first.maxMs >= 100, `stall must register in maxMs, got ${first.maxMs}`)
    // Next window is clean — reset must not carry the spike over.
    await new Promise((r) => setTimeout(r, 60))
    const second = mon.snapshot()
    assert.equal(second.maxMs, first.maxMs, 'reading a snapshot must not clear the spike')
  } finally {
    mon.stop()
  }
})
