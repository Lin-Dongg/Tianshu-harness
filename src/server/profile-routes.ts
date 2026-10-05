import type { DomainUsageResponse, SessionEvent } from './protocol.js'
import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'

export type { DomainUsageResponse } from './protocol.js'

interface HistorySource {
  listAllSessions(): Array<{ id: string }>
  getAllEventsAsync(id: string): Promise<{ events: SessionEvent[]; incomplete?: boolean } | undefined>
}

export function aggregateDomainUsage(histories: Array<{ id: string; events: SessionEvent[] }>, days: 7 | 30, now = Date.now()): DomainUsageResponse {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days + 1)
  const runs = new Map<string, { key: string; ts: number }>()
  const users = new Set<string>()
  let firstRecordedAt: number | null = null
  for (const history of histories) {
    if (history.id.startsWith('worker-')) continue
    for (const event of history.events) {
      if (!Number.isFinite(event.ts) || event.ts > now || event.ts < start.getTime()) continue
      if (event.type === 'user') users.add(event.runId || `${history.id}:${event.seq}`)
      if (event.type !== 'domain_usage' || !event.runId || typeof event.data.key !== 'string' || !event.data.key || event.data.key === 'auto') continue
      const previous = runs.get(event.runId)
      // A fork can replay this marker; its source run and timestamp stay authoritative.
      if (!previous || event.ts < previous.ts) runs.set(event.runId, { key: event.data.key, ts: event.ts })
      firstRecordedAt = firstRecordedAt === null ? event.ts : Math.min(firstRecordedAt, event.ts)
    }
  }
  const domains = new Map<string, { key: string; count: number; lastUsedAt: number }>()
  for (const { key, ts } of runs.values()) {
    const item = domains.get(key) ?? { key, count: 0, lastUsedAt: 0 }
    item.count++; item.lastUsedAt = Math.max(item.lastUsedAt, ts); domains.set(key, item)
  }
  const order = ['qiming', 'tianquan', 'tianji', 'tianshu', 'tianliang', 'huagai', 'yaoguang', 'kaiyang', 'changgeng', 'pojun', 'tianxuan', 'tianfu', 'qisha', 'wenqu', 'fu', 'taiyi']
  const sorted = [...domains.values()].sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)) || a.key.localeCompare(b.key))
  const missingRuns = [...users].filter(id => !runs.has(id)).length
  return { days, totalRuns: runs.size, domains: sorted, coverage: { partial: missingRuns > 0, missingRuns, unreadableSessions: 0, firstRecordedAt } }
}

export function buildProfileRoutes(source: HistorySource, apiToken?: string, now = Date.now): Record<string, RouteHandler> {
  const jobs = new Map<number, { at: number; promise: Promise<DomainUsageResponse> }>()
  return { 'GET /profile/domain-usage': withAuth(async (_body, params) => {
    const raw = params?.days ?? '30'
    if (raw !== '7' && raw !== '30') return { status: 400, body: { error: 'days must be 7 or 30' } }
    const days = Number(raw) as 7 | 30
    const previous = jobs.get(days)
    if (previous && now() - previous.at < 30_000) return { status: 200, body: await previous.promise }
    const promise = (async () => {
      const histories: Array<{ id: string; events: SessionEvent[] }> = []
      let unreadableSessions = 0
      // One log at a time: retain only usage evidence, never whole conversations.
      for (const record of source.listAllSessions()) {
        if (record.id.startsWith('worker-')) continue
        try {
          const result = await source.getAllEventsAsync(record.id)
          if (!result) { unreadableSessions++; continue }
          if (result.incomplete || (result.events.length > 0 && result.events[0]!.seq > 1)) unreadableSessions++
          histories.push({ id: record.id, events: result.events.filter(e => e.type === 'user' || e.type === 'domain_usage') })
        } catch { unreadableSessions++ }
      }
      const result = aggregateDomainUsage(histories, days, now())
      result.coverage.unreadableSessions = unreadableSessions
      result.coverage.partial ||= unreadableSessions > 0
      return result
    })()
    const job = { at: now(), promise }; jobs.set(days, job)
    try { return { status: 200, body: await promise } }
    catch { if (jobs.get(days) === job) jobs.delete(days); return { status: 503, body: { error: 'Local history temporarily unavailable' } } }
  }, apiToken) }
}
