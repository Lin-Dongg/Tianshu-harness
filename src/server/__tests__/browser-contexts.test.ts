import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { getOrCreateSession, getSession } from '../../tools/browser-debug/session.js'
import type { BrowserDebugDriver } from '../../tools/browser-debug/driver.js'
import { createBrowserContext, disposeBrowserContext, disposeAllBrowserContexts, contextFor } from '../browser-contexts.js'
import { browserOwner } from '../../tools/browser-debug/control.js'
import { buildSessionBrowserRoutes } from '../session-browser.js'
import { createRouter } from '../index.js'
import type { RuntimeSessionManager } from '../session-manager.js'

test('contexts are opaque, independent, deduplicated, bounded and disposable', async () => {
  try {
    const [a, duplicate] = await Promise.all([createBrowserContext('a'), createBrowserContext('a')])
    assert.equal(a, duplicate)
    assert.notEqual(a.browserKey, 'a')
    assert.equal(browserOwner('a'), 'agent')
    assert.equal(browserOwner(a.browserKey), 'user')
    assert.ok(existsSync(a.profile))
    assert.throws(() => contextFor('b', a.id), /another session/)
    await Promise.all(['b', 'c', 'd'].map(createBrowserContext))
    await assert.rejects(createBrowserContext('e'), /older preview/)
    await disposeBrowserContext('a', a.id)
    assert.ok(!existsSync(a.profile))
    assert.throws(() => contextFor('a', a.id), /expired/)
    await createBrowserContext('e')
  } finally { await disposeAllBrowserContexts() }
})
test('context routes reject unauthorized and cross-conversation access without starting the agent browser', async () => {
  const manager = { getSession: (id: string) => ['a', 'b'].includes(id) ? { id, cwd: process.cwd() } : undefined } as unknown as RuntimeSessionManager
  const router = createRouter(buildSessionBrowserRoutes(manager, 'fixture'))
  const auth = { authorization: 'Bearer fixture' }
  try {
    assert.equal((await router('POST', '/sessions/a/browser/contexts', {}, {})).status, 401)
    assert.equal((await router('POST', '/sessions/missing/browser/contexts', {}, auth)).status, 404)
    const result = await router('POST', '/sessions/a/browser/contexts', {}, auth)
    const contextId = (result.body as { contextId: string }).contextId
    assert.equal((await router('GET', `/sessions/b/browser?contextId=${contextId}`, {}, auth)).status, 409)
    assert.equal((await router('POST', '/sessions/a/browser', { action: 'control', contextId, owner: 'agent' }, auth)).status, 400)
    assert.equal((await router('GET', '/sessions/a/browser?contextId=', {}, auth)).status, 409)
    assert.equal((await router('GET', `/sessions/a/browser?contextId=${contextId}`, {}, auth)).status, 200)
    assert.equal(browserOwner('a'), 'agent')
  } finally { await disposeAllBrowserContexts() }
})

test('context actions require fresh identity, bound page count, and recheck screenshot after capture', async () => {
  const c = await createBrowserContext('a')
  const manager = { getSession: () => ({ id: 'a', cwd: process.cwd() }) } as unknown as RuntimeSessionManager
  const router = createRouter(buildSessionBrowserRoutes(manager, 'fixture')), auth = { authorization: 'Bearer fixture' }
  let captures = 0, navigations = 0
  const fake = { isAlive: () => true, close: async () => {}, viewportSize: () => ({ width: 800, height: 600 }), listPages: async () => Array.from({ length: 8 }, (_, i) => ({ id: String(i), url: 'http://localhost/' + i, active: i === 0 })), goto: async () => { navigations++ }, screenshot: async () => { captures++; await getSession(c.browserKey)!.frames.changeInteraction(); return Buffer.from('image') } } as unknown as BrowserDebugDriver
  const session = await getOrCreateSession({ sessionKey: c.browserKey, headless: true, userDataDir: c.profile, driverFactory: async () => fake })
  const invoke = (input: object) => router('POST', '/sessions/a/browser', { contextId: c.id, ...input }, auth)
  try {
    assert.equal((await invoke({ action: 'navigate', url: 'http://localhost/new' })).status, 409)
    assert.equal((await invoke({ action: 'open', url: 'http://localhost/new', expectedInteractionId: session.frames.interactionId })).status, 429)
    assert.equal(navigations, 0)
    assert.equal((await invoke({ action: 'screenshot', expectedInteractionId: session.frames.interactionId })).status, 409)
    assert.equal(captures, 1)
    assert.equal(browserOwner('a'), 'agent')
  } finally { await disposeAllBrowserContexts() }
})
test('closing during driver creation cannot retain a live context or profile', async () => {
  const c = await createBrowserContext('late')
  let resolve!: (driver: BrowserDebugDriver) => void, closed = 0
  const opening = getOrCreateSession({ sessionKey: c.browserKey, headless: true, userDataDir: c.profile, driverFactory: () => new Promise(r => { resolve = r }) })
  await disposeBrowserContext('late', c.id)
  resolve({ close: async () => { closed++ } } as unknown as BrowserDebugDriver)
  await opening
  await new Promise(r => setImmediate(r))
  assert.equal(getSession(c.browserKey), null)
  assert.ok(!existsSync(c.profile))
  assert.equal(closed, 1)
})
test('inactive contexts expire rather than displacing the agent browser', async t => {
  const c = await createBrowserContext('expiry')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Rearm under the controlled clock; public renewal uses the same idle policy.
  const { renewBrowserContext, CONTEXT_IDLE_MS } = await import('../browser-contexts.js')
  renewBrowserContext(c)
  t.mock.timers.tick(CONTEXT_IDLE_MS)
  assert.throws(() => contextFor('expiry', c.id), /expired/)
  assert.equal(browserOwner('expiry'), 'agent')
  t.mock.timers.reset()
  await disposeAllBrowserContexts()
})
