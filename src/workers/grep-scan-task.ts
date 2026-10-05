/**
 * Worker-thread task: run the grep fallback regex over one file.
 *
 * Isolated from cpu-tasks.ts so the shared CPU task table stays untouched, and
 * so a catastrophic-backtracking pattern blocks *this* thread instead of the
 * main event loop. The pool's soft timeout rejects the caller; its hard-stuck
 * ceiling terminates this worker. The main thread never re-runs the regex.
 *
 * Loaded by cpu-worker.ts, which runs with Node's native type stripping (no
 * tsx), so imports here must carry the explicit `.ts` extension — a `.js`
 * specifier fails the whole worker load.
 */

// @ts-ignore — native development workers load TypeScript directly.
import { scanForMatches, type MatchLine } from '../tools/bounded-scan.ts'

export interface GrepScanRawResult {
  lines: MatchLine[]
  matchCount: number
  lineTooLongCount: number
  stoppedReason: string
}

/**
 * Literal searches never come here — they cannot backtrack and run inline.
 */
export async function grepScanRaw(
  filePath: string,
  source: string,
  flags: string,
  contextLines: number,
  maxMatches: number,
  maxLineChars: number,
  deadlineMs: number,
): Promise<GrepScanRawResult> {
  const regex = new RegExp(source, flags)
  const res = await scanForMatches(filePath, line => regex.test(line), {
    contextLines,
    maxMatches,
    budget: { maxLineChars, deadlineMs },
  })
  return {
    lines: res.lines,
    matchCount: res.matchCount,
    lineTooLongCount: res.lineTooLongCount,
    stoppedReason: res.stoppedReason,
  }
}
