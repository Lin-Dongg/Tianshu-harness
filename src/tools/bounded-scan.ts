import { createReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

/**
 * Bounded, streaming line scanner.
 *
 * Why this exists: the grep native fallback used to accumulate every scanned
 * line into an array (`allLines`), so peak memory grew with the number of
 * lines in the file — short lines meant millions of retained JS strings and a
 * V8 heap OOM (2026-10-05 P0). This scanner only ever retains the lines the
 * caller actually needs (matches + a bounded context window); a no-match scan
 * retains O(1) regardless of how many lines it walks.
 *
 * It works on raw stream chunks (not `readline`) so it can enforce a per-line
 * byte ceiling: a pathological single line (minified bundle, one-line JSON) is
 * skipped with `lineTooLong` instead of being buffered whole.
 */

export type ScanStopReason =
  | 'eof'
  | 'deadline'
  | 'aborted'
  | 'maxMatches'
  | 'rangeComplete'
  | 'lineTooLong'
  | 'retainedLimit'

export interface ScanBudget {
  /** Stream high-water mark, bytes. Default 64 KiB. */
  chunkBytes?: number
  /**
   * Max UTF-16 code units retained for a single line before it counts as
   * over-long. Default 256 Ki. Deliberately named in code units, not bytes:
   * the check is `String.length`. For ASCII that equals bytes; a non-ASCII line
   * can reach ~2× this in memory, which is still bounded — the earlier "Bytes"
   * naming overstated the guarantee for CJK.
   */
  maxLineChars?: number
  /** Max UTF-16 code units of retained output across the whole scan. Default
   *  8 Mi — same code-unit caveat as `maxLineChars`. */
  maxRetainedChars?: number
  /**
   * What to do with a line longer than `maxLineChars`:
   *  - `skip` (default): drop it and count it as `lineTooLong`. This is the
   *    grep semantic — a truncated line must never be matched.
   *  - `truncate`: emit the first `maxLineChars` code units with
   *    `truncated: true`, so line numbering and later lines stay aligned.
   *    read_file range reads need this: dropping a line silently shifts every
   *    line after it.
   */
  overlongLine?: 'skip' | 'truncate'
  /** Wall-clock budget in ms. Default 30_000. 0 means "already expired". */
  deadlineMs?: number
  signal?: AbortSignal
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number
}

export interface ScanMeta {
  scannedBytes: number
  scannedLines: number
  stoppedReason: ScanStopReason
  /** True only when the scan reached EOF with no skipped (over-long) lines. */
  complete: boolean
  lineTooLongCount: number
  /** The per-line ceiling actually in force (UTF-16 code units). */
  maxLineChars: number
}

export interface MatchLine {
  lineNumber: number
  text: string
  isMatch: boolean
  truncated: boolean
}

export interface MatchScanResult extends ScanMeta {
  lines: MatchLine[]
  matchCount: number
}

export interface RangeLine {
  lineNumber: number
  text: string
  /** True when the line exceeded `maxLineChars` and was returned clipped. */
  truncated: boolean
}

export interface RangeScanResult extends ScanMeta {
  lines: RangeLine[]
  /** Line numbers returned clipped — a subset of `lines`. */
  truncatedLineNumbers: number[]
  /** Real line count — known only when the scan reached EOF (not for a stop
   *  at the range end, where the rest of the file was never read). */
  totalLines: number | null
}

export type LineMatcher = (line: string, lineNumber: number) => boolean

export const DEFAULT_CHUNK_BYTES = 64 * 1024
/** UTF-16 code units — see ScanBudget.maxLineChars. */
export const DEFAULT_MAX_LINE_CHARS = 256 * 1024
export const DEFAULT_MAX_RETAINED_CHARS = 8 * 1024 * 1024
export const DEFAULT_DEADLINE_MS = 30_000

interface LineRecord {
  lineNumber: number
  text: string
  truncated: boolean
}

interface ResolvedBudget {
  chunkBytes: number
  maxLineChars: number
  maxRetainedChars: number
  overlongLine: 'skip' | 'truncate'
  deadlineMs: number
  signal?: AbortSignal
  now: () => number
}

function resolveBudget(budget?: ScanBudget): ResolvedBudget {
  const b = budget ?? {}
  return {
    chunkBytes: b.chunkBytes && b.chunkBytes > 0 ? b.chunkBytes : DEFAULT_CHUNK_BYTES,
    maxLineChars: b.maxLineChars && b.maxLineChars > 0 ? b.maxLineChars : DEFAULT_MAX_LINE_CHARS,
    maxRetainedChars:
      b.maxRetainedChars && b.maxRetainedChars > 0 ? b.maxRetainedChars : DEFAULT_MAX_RETAINED_CHARS,
    overlongLine: b.overlongLine ?? 'skip',
    deadlineMs: b.deadlineMs !== undefined ? b.deadlineMs : DEFAULT_DEADLINE_MS,
    signal: b.signal,
    now: b.now ?? (() => Date.now()),
  }
}

interface StreamOutcome {
  end: 'eof' | 'deadline' | 'aborted'
  requestedStop: ScanStopReason | null
  scannedBytes: number
  scannedLines: number
  lineTooLongCount: number
}

/**
 * Core line walker. Emits complete lines (CRLF stripped, no trailing newline
 * required) to `onLine`; the callback returns a stop reason to end early, or
 * null to continue. Over-long lines are counted and skipped — never buffered.
 */
async function streamLines(
  filePath: string,
  cfg: ResolvedBudget,
  onLine: (rec: LineRecord) => ScanStopReason | null,
): Promise<StreamOutcome> {
  const stream = createReadStream(filePath, { highWaterMark: cfg.chunkBytes })
  const decoder = new StringDecoder('utf8')
  const startedAt = cfg.now()

  let carry = ''
  let overlong = false
  let overlongText = ''
  let lineNumber = 0
  let scannedBytes = 0
  let lineTooLongCount = 0
  let requestedStop: ScanStopReason | null = null
  let end: 'eof' | 'deadline' | 'aborted' = 'eof'

  const expired = (): boolean => cfg.now() - startedAt >= cfg.deadlineMs

  /** Emit a line that exceeded the per-line ceiling, per the configured mode. */
  const emitOverlong = (): boolean => {
    lineNumber++
    lineTooLongCount++
    const text = overlongText
    overlong = false
    overlongText = ''
    if (cfg.overlongLine !== 'truncate') return true
    const stop = onLine({ lineNumber, text, truncated: true })
    if (stop) {
      requestedStop = stop
      return false
    }
    return true
  }

  const finishSegment = (seg: string): boolean => {
    // Returns false when the caller asked to stop.
    if (overlong) return emitOverlong()
    if (seg.length > cfg.maxLineChars) {
      overlongText = seg.slice(0, cfg.maxLineChars)
      return emitOverlong()
    }
    lineNumber++
    const stop = onLine({ lineNumber, text: seg, truncated: false })
    if (stop) {
      requestedStop = stop
      return false
    }
    return true
  }

  try {
    for await (const chunk of stream) {
      if (cfg.signal?.aborted) {
        end = 'aborted'
        break
      }
      if (expired()) {
        end = 'deadline'
        break
      }
      scannedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))

      let text = carry + decoder.write(chunk as Buffer)
      carry = ''
      let nl = text.indexOf('\n')
      let stopped = false
      while (nl !== -1) {
        let seg = text.slice(0, nl)
        text = text.slice(nl + 1)
        if (seg.endsWith('\r')) seg = seg.slice(0, -1)
        if (!finishSegment(seg)) {
          stopped = true
          break
        }
        nl = text.indexOf('\n')
      }
      if (stopped) break

      if (overlong) {
        carry = ''
      } else if (text.length > cfg.maxLineChars) {
        overlong = true
        overlongText = cfg.overlongLine === 'truncate' ? text.slice(0, cfg.maxLineChars) : ''
        carry = ''
      } else {
        carry = text
      }
    }

    if (end === 'eof' && !requestedStop) {
      const tail = carry + decoder.end()
      if (overlong) {
        emitOverlong()
      } else if (tail.length > 0) {
        let seg = tail
        if (seg.endsWith('\r')) seg = seg.slice(0, -1)
        finishSegment(seg)
      }
    }
  } finally {
    stream.destroy()
  }

  return { end, requestedStop, scannedBytes, scannedLines: lineNumber, lineTooLongCount }
}

function finalize(outcome: StreamOutcome, maxLineChars: number): ScanMeta {
  let stoppedReason: ScanStopReason
  if (outcome.requestedStop) stoppedReason = outcome.requestedStop
  else if (outcome.end === 'aborted') stoppedReason = 'aborted'
  else if (outcome.end === 'deadline') stoppedReason = 'deadline'
  else if (outcome.lineTooLongCount > 0) stoppedReason = 'lineTooLong'
  else stoppedReason = 'eof'

  return {
    scannedBytes: outcome.scannedBytes,
    scannedLines: outcome.scannedLines,
    stoppedReason,
    complete: stoppedReason === 'eof',
    lineTooLongCount: outcome.lineTooLongCount,
    maxLineChars,
  }
}

export interface MatchScanOptions {
  /** Trailing/leading context lines around each match. Default 0. */
  contextLines?: number
  /** Stop after this many matches (trailing context still flushed). Default Infinity. */
  maxMatches?: number
  budget?: ScanBudget
}

export async function scanForMatches(
  filePath: string,
  matcher: LineMatcher,
  options: MatchScanOptions = {},
): Promise<MatchScanResult> {
  const cfg = resolveBudget(options.budget)
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? 0))
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY

  const lines: MatchLine[] = []
  const ring: LineRecord[] = []
  let lastEmitted = 0
  let afterRemaining = 0
  let stopAfterWindow = false
  let matchCount = 0
  let retainedChars = 0

  const emit = (rec: LineRecord, isMatch: boolean): boolean => {
    lines.push({ lineNumber: rec.lineNumber, text: rec.text, isMatch, truncated: rec.truncated })
    lastEmitted = rec.lineNumber
    retainedChars += rec.text.length
    return retainedChars <= cfg.maxRetainedChars
  }

  const outcome = await streamLines(filePath, cfg, (rec) => {
    if (matcher(rec.text, rec.lineNumber)) {
      for (const r of ring) {
        if (r.lineNumber > lastEmitted && !emit(r, false)) return 'retainedLimit'
      }
      if (!emit(rec, true)) return 'retainedLimit'
      matchCount++
      afterRemaining = contextLines
      if (matchCount >= maxMatches) {
        if (contextLines === 0) return 'maxMatches'
        stopAfterWindow = true
      }
      return null
    }

    if (afterRemaining > 0) {
      if (!emit(rec, false)) return 'retainedLimit'
      afterRemaining--
      ring.push(rec)
      if (ring.length > contextLines) ring.shift()
      if (stopAfterWindow && afterRemaining === 0) return 'maxMatches'
      return null
    }

    ring.push(rec)
    if (ring.length > contextLines) ring.shift()
    if (stopAfterWindow && contextLines === 0) return 'maxMatches'
    return null
  })

  return { ...finalize(outcome, cfg.maxLineChars), lines, matchCount }
}

export async function scanForRange(
  filePath: string,
  fromLine: number,
  count: number,
  budget?: ScanBudget,
): Promise<RangeScanResult> {
  const cfg = resolveBudget(budget)
  const start = Math.max(1, Math.floor(fromLine))
  const size = Math.max(0, Math.floor(count))
  const endLine = start + size - 1

  const lines: RangeLine[] = []
  let retainedChars = 0

  const outcome = await streamLines(filePath, cfg, (rec) => {
    if (rec.lineNumber < start) return null
    if (rec.lineNumber > endLine) return 'rangeComplete'
    lines.push({ lineNumber: rec.lineNumber, text: rec.text, truncated: rec.truncated })
    retainedChars += rec.text.length
    if (retainedChars > cfg.maxRetainedChars) return 'retainedLimit'
    if (rec.lineNumber === endLine) return 'rangeComplete'
    return null
  })

  return {
    ...finalize(outcome, cfg.maxLineChars),
    lines,
    truncatedLineNumbers: lines.filter(l => l.truncated).map(l => l.lineNumber),
    totalLines: outcome.end === 'eof' && !outcome.requestedStop ? outcome.scannedLines : null,
  }
}
