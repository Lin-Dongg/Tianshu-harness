/**
 * read_file display/UI formatting, split out of read-file.ts to keep that file
 * inside its source-budget ceiling. Both functions are pure string transforms
 * with no session or fs state.
 */

/** Number of head/tail lines kept when previewing a log-like file. */
export const LOG_PREVIEW_LINES = 80

export function buildLogPreviewContent(filePath: string, content: string): string {
  const lines = content.split('\n')
  const headCount = Math.min(LOG_PREVIEW_LINES, lines.length)
  const tailCount = Math.min(LOG_PREVIEW_LINES, Math.max(0, lines.length - headCount))
  const head = lines.slice(0, headCount)
  const tail = tailCount > 0 ? lines.slice(-tailCount) : []
  const omitted = Math.max(0, lines.length - head.length - tail.length)
  const tailStart = tail.length > 0 ? lines.length - tail.length + 1 : 1
  const parts = [
    `read_file: ${filePath} looks like a log/JSONL output file (${content.length} chars, ${lines.length} lines).`,
    `Full first reads of log files waste context; returning a bounded preview only.`,
    `Preview boundaries: head offset=1 limit=${head.length}${tail.length > 0 ? `; tail offset=${tailStart} limit=${tail.length}` : ''}.`,
    `Next step: use read_file(file_path=..., offset=<known line>, limit<=200) for a specific range; use grep on this file for keywords/timestamps before reading middle ranges. Do not scan the whole project for this log.`,
    '',
    `── head (L1-L${head.length}) ──`,
    ...head,
  ]
  if (omitted > 0) {
    parts.push('', `... ${omitted} lines omitted ...`, '', `── tail (L${tailStart}-L${lines.length}) ──`, ...tail)
  }
  return parts.join('\n')
}

/** TUI display: head + tail with line numbers, compact for large files. */
export function buildFileUiOutput(raw: string, maxLines: number): string {
  const lines = raw.split('\n')
  const totalLines = lines.length
  if (totalLines <= maxLines) {
    return lines.map((l, i) => `${String(i + 1).padStart(4, ' ')}│ ${l}`).join('\n')
  }

  const headLines = Math.ceil(maxLines * 0.6)
  const tailLines = Math.floor(maxLines * 0.4)
  const omitted = totalLines - headLines - tailLines

  const head = lines.slice(0, headLines)
    .map((l, i) => `${String(i + 1).padStart(4, ' ')}│ ${l}`)
  const tail = lines.slice(-tailLines)
    .map((l, i) => `${String(totalLines - tailLines + i + 1).padStart(4, ' ')}│ ${l}`)

  return [...head, `  ... ${omitted} lines omitted ...`, ...tail].join('\n')
}
