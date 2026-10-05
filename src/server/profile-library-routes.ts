import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountStore, jwtSubject } from '../auth/account.js'
import { collectUsageRows, aggregateUsageRows } from '../cache/usage-aggregator.js'
import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
import type { FeaturedRepository, ProfileOverview } from './protocol.js'

interface PersonalRecord { totalMs: number; trackedSince: number | null; repositories: FeaturedRepository[] }
export function parseRepositories(value: unknown): FeaturedRepository[] | null {
  if (!Array.isArray(value) || value.length > 6) return null
  const result: FeaturedRepository[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item.url !== 'string' || typeof item.title !== 'string' || typeof item.description !== 'string' || item.title.length > 80 || item.description.length > 240) return null
    let url: URL
    try { url = new URL(item.url) } catch { return null }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null
    const match = /^\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d._-]{1,100})\/?$/i.exec(url.pathname)
    if (!match || ['.', '..'].includes(match[2]!)) return null
    const canonical = `https://github.com/${match[1]}/${match[2]!.replace(/\.git$/i, '')}`
    if (canonical.endsWith('/') || seen.has(canonical.toLowerCase())) return null
    seen.add(canonical.toLowerCase())
    result.push({ url: canonical, title: item.title.trim() || `${match[1]}/${match[2]!.replace(/\.git$/i, '')}`, description: item.description.trim() })
  }
  return result
}
export function presenceCredit(previous: { owner: string; at: number } | undefined, owner: string | null, now: number): number {
  const elapsed = previous ? now - previous.at : 0
  // Unknown gaps and account changes earn no time; crash/sleep must not inflate usage.
  return previous?.owner === owner && elapsed >= 0 && elapsed <= 45_000 ? elapsed : 0
}
export function buildProfileLibraryRoutes(options: { rivetHome: string; apiToken?: string; now?: () => number; owner?: () => string | null; usage?: () => Promise<NonNullable<ProfileOverview['tokens']>> }): Record<string, RouteHandler> {
  const now = options.now ?? Date.now
  const owner = options.owner ?? (() => {
    const account = accountStore(options.rivetHome).load()
    return account?.accessToken ? jwtSubject(account.accessToken) : null
  })
  const key = (id: string | null) => id ? createHash('sha256').update(id).digest('hex') : 'local'
  const file = join(options.rivetHome, 'profile-center.json')
  let records: Record<string, PersonalRecord> = Object.create(null)
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const [id, raw] of Object.entries(data) as Array<[string, PersonalRecord]>) {
      if (!/^(local|[a-f\d]{64})$/.test(id) || !raw || !Number.isFinite(raw.totalMs) || raw.totalMs < 0) continue
      const repositories = parseRepositories(raw.repositories)
      if (repositories) records[id] = { totalMs: raw.totalMs, trackedSince: Number.isFinite(raw.trackedSince) ? raw.trackedSince : null, repositories }
    }
  } catch { /* New installation or incomplete local profile data. */ }
  const record = (id: string) => records[id] ??= { totalMs: 0, trackedSince: null, repositories: [] }
  const save = () => {
    mkdirSync(options.rivetHome, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 })
    renameSync(temporary, file)
  }
  const update = (id: string, value: PersonalRecord) => {
    const old = records[id]; records[id] = value
    try { save() } catch (error) { if (old) records[id] = old; else delete records[id]; throw error }
  }
  let previous: { owner: string; at: number } | undefined
  let usageJob: { at: number; promise: Promise<NonNullable<ProfileOverview['tokens']>> } | undefined
  const usage = () => {
    if (usageJob && now() - usageJob.at < 300_000) return usageJob.promise
    const promise = options.usage ? options.usage() : (async () => {
      const days = Math.ceil(now() / 86_400_000) + 1
      const collected = await collectUsageRows(process.env.RIVET_SESSION_DIR ?? join(options.rivetHome, 'sessions'), { days, now: now() })
      const aggregate = aggregateUsageRows(collected.rows, { days, now: now() })
      const totals = aggregate.days.map(day => day.input + day.output)
      return { total: aggregate.totals.input + aggregate.totals.output, peak: totals.reduce((peak, value) => Math.max(peak, value), 0), activeDays: totals.filter(value => value > 0).length, scannedFiles: collected.scannedFiles }
    })()
    const job = { at: now(), promise }; usageJob = job
    void promise.catch(() => { if (usageJob === job) usageJob = undefined })
    return promise
  }
  return {
    'POST /profile/presence': withAuth(async body => {
      const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {}
      if (typeof payload.active !== 'boolean') return { status: 400, body: { error: 'active must be boolean' } }
      const current = owner(), at = now(), credit = presenceCredit(previous, current, at)
      if (current) {
        const value = record(key(current))
        if (credit || payload.active) update(key(current), { ...value, totalMs: value.totalMs + credit, trackedSince: value.trackedSince ?? (payload.active ? at : null) })
      }
      previous = current && payload.active ? { owner: current, at } : undefined
      return { status: 200, body: { ok: true } }
    }, options.apiToken),
    'GET /profile/overview': withAuth(async () => {
      const profileKey = key(owner()), value = record(profileKey)
      const tokens = await usage().catch(() => null)
      if (profileKey !== key(owner())) return { status: 409, body: { error: 'Account changed; retry' } }
      return { status: 200, body: { profileKey, login: { totalMs: value.totalMs, trackedSince: value.trackedSince }, repositories: value.repositories, tokens } satisfies ProfileOverview }
    }, options.apiToken),
    'PUT /profile/repositories': withAuth(async body => {
      const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {}
      const profileKey = key(owner())
      if (payload.profileKey !== profileKey) return { status: 409, body: { error: 'Account changed; reload profile' } }
      const repositories = parseRepositories(payload.repositories)
      if (!repositories) return { status: 400, body: { error: 'Use up to six unique GitHub repository links, titles up to 80 and descriptions up to 240 characters' } }
      update(profileKey, { ...record(profileKey), repositories })
      return { status: 200, body: { repositories } }
    }, options.apiToken),
  }
}
