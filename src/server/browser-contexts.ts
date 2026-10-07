import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { browserOperation, setBrowserOwner, forgetBrowserControl } from '../tools/browser-debug/control.js'
import { closeSession, getSession } from '../tools/browser-debug/session.js'
import { BrowserOperationError } from '../tools/browser-debug/operation-error.js'

export interface BrowserContext { id: string; sessionId: string; browserKey: string; profile: string; timer?: ReturnType<typeof setTimeout>; closed: boolean }
const contexts = new Map<string, BrowserContext>()
const creating = new Map<string, Promise<BrowserContext>>()
export const CONTEXT_IDLE_MS = 30 * 60 * 1000
export function contextFor(sessionId: string, id: unknown): BrowserContext {
  const context = typeof id === 'string' ? contexts.get(id) : undefined
  if (!context || context.closed || context.sessionId !== sessionId) throw new BrowserOperationError('stale_context', 'Browser context expired or belongs to another session')
  return context
}
export function renewBrowserContext(context: BrowserContext) {
  contextFor(context.sessionId, context.id)
  clearTimeout(context.timer)
  context.timer = setTimeout(() => { void disposeBrowserContext(context.sessionId, context.id) }, CONTEXT_IDLE_MS)
  context.timer.unref()
}
export async function createBrowserContext(sessionId: string): Promise<BrowserContext> {
  const existing = [...contexts.values()].find(c => c.sessionId === sessionId && !c.closed)
  if (existing) { renewBrowserContext(existing); return existing }
  if (creating.has(sessionId)) return creating.get(sessionId)!
  if (contexts.size + creating.size >= 4) throw new BrowserOperationError('resource_limit', 'Close an older preview before opening another conversation')
  const promise = (async () => {
    const profile = await mkdtemp(join(tmpdir(), 'rivet-browser-context-'))
    const id = randomUUID(), browserKey = 'context-' + id
    const context: BrowserContext = { id, sessionId, browserKey, profile, closed: false }
    contexts.set(id, context)
    setBrowserOwner(browserKey, 'user')
    renewBrowserContext(context)
    return context
  })()
  creating.set(sessionId, promise)
  try { return await promise } finally { if (creating.get(sessionId) === promise) creating.delete(sessionId) }
}
export async function disposeBrowserContext(sessionId: string, id: string) {
  const c = contexts.get(id)
  if (!c || c.sessionId !== sessionId) return
  c.closed = true; contexts.delete(id); clearTimeout(c.timer)
  await closeSession(c.browserKey)
  await browserOperation(c.browserKey, 'user', async () => { await closeSession(c.browserKey) }).catch(() => {})
  forgetBrowserControl(c.browserKey)
  await rm(c.profile, { recursive: true, force: true }).catch(() => {})
}
export async function disposeSessionBrowserContexts(sessionId: string) {
  const pending = creating.get(sessionId)
  if (pending) await pending.catch(() => {})
  await Promise.all([...contexts.values()].filter(c => c.sessionId === sessionId).map(c => disposeBrowserContext(sessionId, c.id)))
}
export async function disposeAllBrowserContexts() {
  await Promise.all([...creating.values()].map(p => p.catch(() => {})))
  await Promise.all([...contexts.values()].map(c => disposeBrowserContext(c.sessionId, c.id)))
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void disposeAllBrowserContexts() })
