import { verificationArgv } from './verification-command.js'

/** Only literal trailing stdout/stderr redirects preserve one validator's exit. */
export function splitVerificationRedirection(command: string): { command: string; suffix: string } | undefined {
  if (/[\n\r\\]/.test(command)) return undefined
  let quote = '', split = -1
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '>') {
      split = i
      const fd = /(?:^|\s)(\d+)$/.exec(command.slice(0, i))?.[1]
      if (fd && !['1', '2'].includes(fd)) return undefined
      if (fd) split -= fd.length
      break
    }
  }
  if (split < 0) return undefined
  const prefix = command.slice(0, split).trimEnd(), suffix = command.slice(split)
  let offset = 0
  while (offset < suffix.length) {
    while (/\s/.test(suffix[offset] ?? '') && offset < suffix.length) offset++
    if (offset === suffix.length) break
    const op = /^(?:[12]?>&[12]|[12]?>>?)/.exec(suffix.slice(offset))?.[0]
    if (!op) return undefined
    offset += op.length
    if (op.includes('&')) continue
    while (/\s/.test(suffix[offset] ?? '') && offset < suffix.length) offset++
    const start = offset
    let quoted = ''
    for (; offset < suffix.length; offset++) {
      const c = suffix[offset]!
      if (quoted) { if (c === quoted) quoted = ''; continue }
      if (c === "'" || c === '"') { quoted = c; continue }
      if (/\s/.test(c)) break
      if (/[;&|<>]/.test(c)) return undefined
    }
    const target = verificationArgv(suffix.slice(start, offset))
    if (quoted || !target || target.length !== 1 || !target[0] || /[*?[\]~\\]/.test(target[0])) return undefined
  }
  return prefix ? { command: prefix, suffix: ' ' + suffix } : undefined
}
