/**
 * Explicit-range reads for read_file, split out of read-file.ts to keep that
 * file inside its source-budget ceiling.
 *
 * Streams only the requested window (the whole file is never materialised) and
 * reports what the caller must surface: out-of-range requests, lines that were
 * clipped, and early stops.
 */
import { readFile } from 'node:fs/promises'
import { scanForRange } from './bounded-scan.js'
import { truncateContent } from './truncation.js'
import { buildFileUiOutput } from './read-file-views.js'

export interface RangeReadResult {
  /** Set when the request must be rejected; both texts are ready to return. */
  error?: { raw: string; model: string }
  /** Selected lines joined with \n (no trailing newline). */
  content: string
  /** Note to append to the model-facing content ('' when nothing to report). */
  note: string
}

export interface HeadReadResult {
  content: string
  /** True when the file continued past the retained window. */
  clipped: boolean
}

/**
 * Bounded head read for a no-range read of a large file.
 *
 * `readFile` + `split('\n')` materialises a multi-million-element line array,
 * which is what exhausts the heap on a large short-line file (P0). This returns
 * only the leading content, capped by `maxChars`, and never splits the whole
 * file.
 */
export async function readBoundedHead(filePath: string, maxChars: number): Promise<HeadReadResult> {
  const cap = Math.max(64 * 1024, Math.floor(maxChars))
  const scan = await scanForRange(filePath, 1, Number.MAX_SAFE_INTEGER, {
    overlongLine: 'truncate',
    maxRetainedChars: cap,
  })
  return {
    content: scan.lines.map(l => l.text).join('\n'),
    clipped: scan.stoppedReason === 'retainedLimit' || scan.totalLines === null,
  }
}

function errorResult(raw: string, model: string): RangeReadResult {
  return { error: { raw, model }, content: '', note: '' }
}

export async function readExplicitRange(
  filePath: string,
  offset: number,
  limit: number | undefined,
): Promise<RangeReadResult> {
  if (offset < 1) {
    return errorResult(
      `Error: offset must be >= 1 (got ${offset})`,
      `Error: offset must be >= 1 (got ${offset}). Lines are 1-based.`,
    )
  }

  const count = limit !== undefined ? Math.max(0, Math.floor(limit)) : Number.MAX_SAFE_INTEGER
  // `truncate`: an over-long line is returned clipped rather than dropped —
  // dropping it would shift every later line, and would fabricate an
  // out-of-range error when the only line is over-long (P0 review fix).
  const scan = await scanForRange(filePath, offset, count, { overlongLine: 'truncate' })

  // A file with no lines (0 bytes) is not "out of range": return empty content,
  // matching the pre-streaming behaviour.
  if (scan.lines.length === 0 && scan.totalLines !== null && scan.totalLines > 0) {
    const total = scan.totalLines
    return errorResult(
      `Error: offset ${offset} exceeds file length (${total} lines)`,
      `Error: offset ${offset} exceeds file length (${total} lines). File has ${total} lines. Re-read without offset or use a smaller offset value.`,
    )
  }

  const notes: string[] = []
  if (scan.truncatedLineNumbers.length > 0) {
    const shown = scan.truncatedLineNumbers.slice(0, 10).join(', L')
    const more = scan.truncatedLineNumbers.length > 10 ? ' …' : ''
    notes.push(`${scan.truncatedLineNumbers.length} 行超过单行上限（${scan.maxLineChars} 字符），已截断：L${shown}${more}`)
  }
  // An early stop (deadline / abort / retention cap) means the window is
  // partial — say so rather than let the model read it as "nothing here".
  if (scan.stoppedReason === 'deadline' || scan.stoppedReason === 'aborted' || scan.stoppedReason === 'retainedLimit') {
    notes.push(`扫描提前结束（${scan.stoppedReason}），以下内容不覆盖完整范围`)
  }

  return {
    content: scan.lines.map(l => l.text).join('\n'),
    note: notes.length > 0 ? `\n\n── ${notes.join('；')} ──` : '',
  }
}

/** Files at or below this size are read whole; larger ones take a bounded head. */
export const READ_WHOLE_MAX_BYTES = 2 * 1024 * 1024

export interface NoRangeContent {
  content: string
  /** Non-empty only when `content` is a bounded head (the file is larger). */
  headNote: string
}

/**
 * Supply content for a no-range read. A large file must never be materialised:
 * the line split, not the read, is what exhausts the heap on a short-line file
 * (P0). Large files get a bounded head plus a note stating the TRUE file size —
 * downstream views label content with its own line/char counts, so they must be
 * bypassed for a head (see headBoundedPayload).
 */
export async function supplyNoRangeContent(
  filePath: string,
  fileSize: number,
  hasFocus: boolean,
  prefetchedContent: string | undefined,
  cap: { maxChars: number },
): Promise<NoRangeContent> {
  if (prefetchedContent !== undefined) return { content: prefetchedContent, headNote: '' }
  if (hasFocus || fileSize <= READ_WHOLE_MAX_BYTES) {
    return { content: await readFile(filePath, 'utf-8'), headNote: '' }
  }
  const head = await readBoundedHead(filePath, Math.max(cap.maxChars * 2, 256 * 1024))
  const headNote = head.clipped
    ? `── 文件 ${(fileSize / 1048576).toFixed(1)} MB；未统计总行数，仅返回前部 ${head.content.length} 字符 —— 其余请用 offset/limit 或 grep/read_section 定位 ──\n\n`
    : ''
  return { content: head.content, headNote }
}

export interface HeadBoundedPayload {
  canonicalPath: string
  rawContent: string
  modelContent: string
  uiContent: string
  /** Always true — consumers must not treat this content as the whole file. */
  headBounded: true
}

/**
 * Payload for a bounded-head read. A head is not the file: the PARTIAL/preview
 * views state the line/char counts of whatever content they are handed, so
 * using them here made the model report a 48 MB file as "16385 lines / 278544
 * chars" (caught in a real run). State the true size instead.
 *
 * `headBounded` is the single marker every other channel keys off: dedup /
 * read-ref must not claim "already read in full", raw output must not be
 * persisted as if it were the file, and the UI must not present it as one.
 */
export function headBoundedPayload(
  filePath: string,
  headNote: string,
  content: string,
  cap: { maxChars: number; headChars: number; tailChars: number },
): HeadBoundedPayload {
  return {
    canonicalPath: filePath,
    rawContent: content,
    modelContent: headNote + truncateContent(content, cap.maxChars, cap.headChars, cap.tailChars),
    uiContent: `── read_file: 仅返回文件前部（非完整内容）──\n${buildFileUiOutput(content, 80)}`,
    headBounded: true,
  }
}
