import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateDomainUsage, buildProfileRoutes } from '../profile-routes.js'
import { createRouter } from '../index.js'
import type { SessionEvent } from '../protocol.js'

const now = new Date(2026, 0, 2, 12).getTime()
function event(type: SessionEvent['type'], runId: string, key?: string, ts = now): SessionEvent {
  return { seq: 1, ts, type, runId, data: key ? { key, sourceSessionId: 'original' } : {} }
}
test('actual runs deduplicate across attempts and copied forks; workers and selections do not count', () => {
  const result = aggregateDomainUsage([
    { id: 'a', events: [event('user', 'one'), event('domain_usage', 'one', 'kaiyang'), event('domain_usage', 'one', 'kaiyang'), event('domain_changed', 'two', 'pojun')] },
    { id: 'fork', events: [event('user', 'one'), event('domain_usage', 'one', 'kaiyang'), event('user', 'three'), event('domain_usage', 'three', 'tianliang')] },
    { id: 'worker-a', events: [event('user', 'worker'), event('domain_usage', 'worker', 'pojun')] },
  ], 30, now)
  assert.equal(result.totalRuns, 2)
  assert.deepEqual(result.domains.map(d => [d.key, d.count]), [['tianliang', 1], ['kaiyang', 1]])
  assert.equal(result.coverage.missingRuns, 0)
})
test('unknown historical domains are disclosed rather than inferred from current selection', () => {
  const result = aggregateDomainUsage([{ id: 'old', events: [event('user', 'old'), event('domain_changed', 'old', 'pojun'), { ...event('user', ''), runId: undefined, seq: 2 }] }], 7, now)
  assert.equal(result.totalRuns, 0)
  assert.equal(result.coverage.missingRuns, 2)
  assert.equal(result.coverage.partial, true)
})
test('calendar boundaries include today and cross years; future and out-of-window events are ignored', () => {
  const firstDay = new Date(2025, 11, 27).getTime()
  const rows = [event('domain_usage', 'first', 'tianquan', firstDay), event('domain_usage', 'before', 'pojun', firstDay - 1), event('domain_usage', 'future', 'pojun', now + 1)]
  assert.equal(aggregateDomainUsage([{ id: 'a', events: rows }], 7, now).totalRuns, 1)
})
test('custom domains remain visible, malformed markers are ignored, zero history stays empty', () => {
  assert.deepEqual(aggregateDomainUsage([], 30, now).domains, [])
  const result = aggregateDomainUsage([{ id: 'a', events: [event('domain_usage', 'one', 'custom-domain'), event('domain_usage', '', 'pojun'), event('domain_usage', 'unknown', 'auto')] }], 30, now)
  assert.equal(result.domains[0]?.key, 'custom-domain')
  assert.equal(result.totalRuns, 1)
})
test('route is authenticated, validates windows, merges concurrent reads and reports per-session read failures', async () => {
  let reads = 0
  const router = createRouter(buildProfileRoutes({ listAllSessions: () => [{ id: 'a' }, { id: 'broken' }],
    getAllEventsAsync: async id => { reads++; if (id === 'broken') throw new Error('disk'); await new Promise(r => setTimeout(r, 5)); return { events: [event('user', 'one'), event('domain_usage', 'one', 'kaiyang')] } },
  }, 'fake-profile-auth', () => now))
  assert.equal((await router('GET', '/profile/domain-usage?days=30', undefined)).status, 401)
  const headers = { authorization: 'Bearer fake-profile-auth' }
  assert.equal((await router('GET', '/profile/domain-usage?days=8', undefined, headers)).status, 400)
  const results = await Promise.all([router('GET', '/profile/domain-usage?days=30', undefined, headers), router('GET', '/profile/domain-usage?days=30', undefined, headers)])
  assert.equal(reads, 2)
  assert.equal(results[0].status, 200)
  assert.equal((results[0].body as any).coverage.unreadableSessions, 1)
})
