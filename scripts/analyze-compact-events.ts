/**
 * Compact-event analyzer — was each context compaction necessary, and what did it cost?
 *
 * Reads per-turn cache-log.jsonl entries and reports the history rewrites
 * (compact / partial / session-split / stale-round / heap micro-compact),
 * attributing each one with:
 *   - compactPreRatio : window fill ratio just before the rewrite (necessity signal)
 *   - compactReclaimed: tokens freed by the rewrite (benefit)
 *   - hitRate         : the turn's cache hit-rate (the cost the break paid)
 *
 * A rewrite with a low pre-ratio is a candidate wasteful prefix-cache break:
 * it paid a cache cost for headroom the window did not yet need.
 *
 * Usage:
 *   npx tsx scripts/analyze-compact-events.ts            # all sessions for this cwd
 *   npx tsx scripts/analyze-compact-events.ts <id-prefix> # one session
 *   RIVET_SESSION_DIR=/path npx tsx scripts/analyze-compact-events.ts
 *
 * Requires the compact-attribution instrumentation (compactPreRatio etc. in cache-log).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getSessionDir } from '../src/agent/session-persist.js'
import { LOW_PRESSURE_REWRITE_RATIO, isLowPressureRewrite } from '../src/agent/compact-attribution.js'

interface LogEntry {
  turn?: number
  model?: string
  hitRate?: string
  historyRewritten?: boolean
  compactPreRatio?: number
  compactReclaimed?: number
  compactTokensBefore?: number
  compactTokensAfter?: number
  /** reclaim_decision rows (loop-factory.ts recorder) — committed AND rejected
   *  gate decisions. The other half of the rewrite ledger: the historyRewritten
   *  rows above attest rewrites that HAPPENED; these attest candidates the gate
   *  REJECTED or that force paths pushed through. */
  event?: string
  action?: string
  commit?: boolean
  reason?: string
  force?: boolean
  reclaimedTokens?: number
  reclaimRatio?: number
}

function parseHitRate(s: string | undefined): number | undefined {
  if (typeof s !== 'string') return undefined
  const n = Number.parseFloat(s.replace('%', ''))
  return Number.isFinite(n) ? n : undefined
}

function readSessionLog(dir: string): LogEntry[] {
  const file = join(dir, 'cache-log.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const entries: LogEntry[] = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as LogEntry) } catch { /* skip malformed */ }
  }
  return entries
}

interface Agg {
  turns: number
  rewrites: number
  lowPressure: number
  reclaimed: number
  reclaimedCount: number
  preRatioSum: number
  preRatioCount: number
  hitRateSum: number
  hitRateCount: number
  suspicious: Array<{ turn?: number; preRatio?: number; reclaimed?: number; hitRate?: number }>
}

function emptyAgg(): Agg {
  return {
    turns: 0, rewrites: 0, lowPressure: 0, reclaimed: 0, reclaimedCount: 0,
    preRatioSum: 0, preRatioCount: 0, hitRateSum: 0, hitRateCount: 0, suspicious: [],
  }
}

function accumulate(agg: Agg, e: LogEntry): void {
  agg.turns++
  if (e.historyRewritten !== true) return
  agg.rewrites++
  const hr = parseHitRate(e.hitRate)
  if (typeof e.compactReclaimed === 'number') { agg.reclaimed += e.compactReclaimed; agg.reclaimedCount++ }
  if (typeof e.compactPreRatio === 'number') { agg.preRatioSum += e.compactPreRatio; agg.preRatioCount++ }
  if (typeof hr === 'number') { agg.hitRateSum += hr; agg.hitRateCount++ }
  if (isLowPressureRewrite(e.compactPreRatio)) {
    agg.lowPressure++
    agg.suspicious.push({ turn: e.turn, preRatio: e.compactPreRatio, reclaimed: e.compactReclaimed, hitRate: hr })
  }
}

function avg(n: number, d: number): string {
  return d > 0 ? (n / d).toFixed(2) : 'n/a'
}

function reportAgg(label: string, agg: Agg): void {
  console.log(`  ${label}`)
  console.log(`    turns                 : ${agg.turns}`)
  console.log(`    history rewrites      : ${agg.rewrites}`)
  if (agg.rewrites === 0) return
  console.log(`    avg pre-ratio         : ${avg(agg.preRatioSum, agg.preRatioCount)}`)
  console.log(`    avg reclaimed tokens  : ${avg(agg.reclaimed, agg.reclaimedCount)}`)
  console.log(`    avg hitRate on rewrite: ${avg(agg.hitRateSum, agg.hitRateCount)}%`)
  console.log(`    low-pressure rewrites : ${agg.lowPressure} (pre-ratio < ${LOW_PRESSURE_REWRITE_RATIO})`)
  for (const s of agg.suspicious.slice(0, 10)) {
    console.log(`      ! turn ${s.turn ?? '?'}: preRatio=${s.preRatio ?? '?'} reclaimed=${s.reclaimed ?? '?'} hitRate=${s.hitRate ?? '?'}%`)
  }
}

function verdict(agg: Agg): void {
  console.log('Verdict:')
  if (agg.rewrites === 0) {
    console.log('  No history rewrites recorded — nothing to attribute.')
    return
  }
  if (agg.lowPressure === 0) {
    console.log('  All rewrites fired under genuine window pressure — no wasteful breaks detected.')
    return
  }
  const share = (agg.lowPressure / agg.rewrites) * 100
  console.log(`  ${agg.lowPressure}/${agg.rewrites} (${share.toFixed(0)}%) rewrites broke the prefix cache`)
  console.log(`  while the window was below ${LOW_PRESSURE_REWRITE_RATIO} fill — candidate wasteful compactions.`)
  console.log('  Investigate the compaction gate that fired at those turns.')
}

/**
 * Reclaim-gate rows (event:'reclaim_decision').
 *
 * The attribution above only sees rewrites that happened. These rows are the
 * gate's own ledger — including candidates it REJECTED — so "compressed but
 * reclaimed nothing" stops being invisible. `unchanged` rejects are no-ops the
 * coordinator already drains (it clears pending debt rather than respinning);
 * a rejected-but-CHANGED candidate (below-reclaim-floor / no-reclaim) is the
 * churn shape: the rewrite did work, freed too little to beat the cache
 * rebuild, and the boundary may retry it next turn. The forced count surfaces
 * how much of the gate's traffic is emergency-path compulsion rather than
 * economic selection.
 */
/** 强制提交占全部提交的比例越过此阈值时告警：多数压缩走紧急强制路径，
 *  reclaim gate 的经济筛选作用有限（真机实测 22/28 = 79%）。 */
export const FORCED_SHARE_WARN = 0.6

interface ReclaimAgg {
  total: number
  committed: number
  rejected: number
  /** Rows carrying force=true (emergency paths: heap / ceiling / session split).
   *  Note: force can still resolve to `unchanged` (shouldCommitReclaim checks
   *  !changed before `force`), so this counts the *path*, not the commits. */
  forced: number
  /** Commits that came from a forced path — the rest committed through the
   *  economic reclaim floor (`gated`). */
  forcedCommitted: number
  changedRejected: number
  reasonCounts: Map<string, number>
  churn: Array<{ turn?: number; reason: string; reclaimedTokens?: number; reclaimRatio?: number }>
}

function emptyReclaimAgg(): ReclaimAgg {
  return { total: 0, committed: 0, rejected: 0, forced: 0, forcedCommitted: 0, changedRejected: 0, reasonCounts: new Map(), churn: [] }
}

/** A rejected candidate that actually changed history but reclaimed below the
 *  profile floor — the wasteful-retry shape (distinct from a no-op reject). */
function isChangedReject(e: LogEntry): boolean {
  return e.commit === false && e.reason !== undefined && e.reason !== 'unchanged'
}

function accumulateReclaim(agg: ReclaimAgg, e: LogEntry): void {
  if (e.event !== 'reclaim_decision') return
  agg.total++
  if (e.commit === true) agg.committed++
  else {
    agg.rejected++
    if (isChangedReject(e)) agg.changedRejected++
  }
  if (e.force === true) agg.forced++
  if (e.commit === true && e.force === true) agg.forcedCommitted++
  const reason = e.reason ?? 'unknown'
  agg.reasonCounts.set(reason, (agg.reasonCounts.get(reason) ?? 0) + 1)
  if (isChangedReject(e)) {
    agg.churn.push({ turn: e.turn, reason, reclaimedTokens: e.reclaimedTokens, reclaimRatio: e.reclaimRatio })
  }
}

function reportReclaim(label: string, agg: ReclaimAgg): void {
  if (agg.total === 0) return
  const forcedShare = ((agg.forced / agg.total) * 100).toFixed(0)
  const reasons = [...agg.reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(' · ')
  console.log(`  ${label}`)
  console.log(`    reclaim_decision      : ${agg.total} (committed ${agg.committed} / rejected ${agg.rejected})`)
  console.log(`    forced                : ${agg.forced} (${forcedShare}%)`)
  console.log(`    committed             : ${agg.committed} (forced ${agg.forcedCommitted} · gated ${agg.committed - agg.forcedCommitted})`)
  console.log(`    changed-but-rejected  : ${agg.changedRejected}`)
  console.log(`    reasons               : ${reasons}`)
  for (const c of agg.churn.slice(0, 10)) {
    console.log(`      ! turn ${c.turn ?? '?'}: ${c.reason} reclaimed=${c.reclaimedTokens ?? '?'} ratio=${c.reclaimRatio ?? '?'}`)
  }
}

function reclaimVerdict(agg: ReclaimAgg): void {
  if (agg.total === 0) return
  if (agg.changedRejected === 0) {
    console.log('  Reclaim gate: no rewrite-level churn — every rejection was a no-op candidate.')
  } else {
    const share = ((agg.changedRejected / agg.total) * 100).toFixed(0)
    console.log(`  Reclaim gate: ${agg.changedRejected} changed-but-rejected candidate(s) (${share}% of decisions).`)
    console.log('  These rewrites did work but freed below the profile floor — check whether the same')
    console.log('  boundary retries them every turn (compaction churn) or the floor is mis-set.')
  }
  const forcedShare = agg.committed > 0 ? agg.forcedCommitted / agg.committed : 0
  if (forcedShare >= FORCED_SHARE_WARN) {
    console.log(`  Note: forced share ${(forcedShare * 100).toFixed(0)}% ≥ ${(FORCED_SHARE_WARN * 100).toFixed(0)}% of commits —`)
    console.log('  most compactions are emergency-path compulsion; the reclaim gate selects few rewrites.')
  }
}

/**
 * Discover session dirs that actually hold a cache-log.jsonl.
 *
 * Two layouts exist: flat `root/<sessionId>/` (single-project / test runs) and
 * production `root/<slug>/<sessionId>/` (sessionsDir() nests by project slug).
 * A flat-only scan finds the slug dirs (687 of them on this machine) and zero
 * logs, so every real session reads as empty.
 */
function discoverSessionDirs(root: string): string[] {
  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }
  const hasLog = (p: string): boolean => existsSync(join(p, 'cache-log.jsonl'))
  const dirs: string[] = []
  for (const name of readdirSync(root)) {
    const top = join(root, name)
    if (!isDir(top)) continue
    if (hasLog(top)) { dirs.push(top); continue } // flat layout
    for (const sub of readdirSync(top)) {
      const nested = join(top, sub)
      if (isDir(nested) && hasLog(nested)) dirs.push(nested)
    }
  }
  return dirs
}

function main(): void {
  const prefix = process.argv[2]
  const root = getSessionDir(process.cwd())
  if (!existsSync(root)) {
    console.error(`Session dir not found: ${root}`)
    console.error('Set RIVET_SESSION_DIR or run from a project that has run sessions.')
    process.exit(1)
  }

  const sessionDirs = discoverSessionDirs(root)
    .filter(p => !prefix || p.includes(prefix))

  if (sessionDirs.length === 0) {
    console.error(`No session directories found under ${root}${prefix ? ` matching "${prefix}"` : ''}`)
    process.exit(1)
  }

  console.log(`Compact-event attribution — ${sessionDirs.length} session(s) under ${root}\n`)

  const overall = emptyAgg()
  const overallReclaim = emptyReclaimAgg()
  for (const dir of sessionDirs) {
    const entries = readSessionLog(dir)
    if (entries.length === 0) continue
    const agg = emptyAgg()
    const reclaim = emptyReclaimAgg()
    for (const e of entries) {
      accumulate(agg, e); accumulate(overall, e)
      accumulateReclaim(reclaim, e); accumulateReclaim(overallReclaim, e)
    }
    if (agg.turns === 0) continue
    const id = basename(dir)
    reportAgg(id.slice(0, 12), agg)
    reportReclaim(id.slice(0, 12), reclaim)
    console.log('')
  }

  console.log('─'.repeat(50))
  reportAgg('OVERALL', overall)
  reportReclaim('OVERALL', overallReclaim)
  console.log('')
  verdict(overall)
  reclaimVerdict(overallReclaim)
}

main()
