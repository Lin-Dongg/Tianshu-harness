import { ANSI, enforceTextContract } from '../engine/ansi.js'
import { ambiguousWideEnabled, displayWidth, truncateToDisplayWidth } from '../width.js'

export function proseColumns(columns: number, indentColumns = 0): number {
  return Math.max(1, columns - indentColumns - 1)
}

/** Keep styles, links and graphemes intact when prose wraps. */
export function wrapReadingText(text: string, width: number, continuation = ''): string[] {
  const rows: string[] = [], wide = { ambiguousAsWide: ambiguousWideEnabled() }
  width = Math.max(1, width)
  continuation = truncateToDisplayWidth(continuation, Math.max(0, width - 2), wide)
  type Atom = { text: string; cells: number; control?: boolean }
  let pending: Atom[] = [], styles = '', link = '', prefix = '', cells = 0
  const closeLink = '\x1b]8;;\x1b\\'
  const emit = (count: number, wrapping: boolean) => {
    const chunk = pending.splice(0, count)
    let end = chunk.length
    if (wrapping) {
      while (end > 0 && (chunk[end - 1]!.control || chunk[end - 1]!.text === ' ')) end--
    }
    let current = styles + link + prefix
    for (let i = 0; i < chunk.length; i++) {
      const atom = chunk[i]!
      if (i < end || atom.control || !wrapping) current += atom.text
      if (atom.control) {
        if (atom.text.startsWith('\x1b]8;')) link = atom.text === closeLink || atom.text === '\x1b]8;;\x07' ? '' : atom.text
        else styles = atom.text === ANSI.RESET ? '' : styles + atom.text
      }
    }
    rows.push(current + (link ? closeLink : '') + (styles ? ANSI.RESET : ''))
    prefix = continuation
    cells = displayWidth(prefix, wide) + pending.reduce((n, atom) => n + atom.cells, 0)
  }
  const append = (atom: Atom) => {
    while (cells + atom.cells > width && pending.some(part => part.cells > 0)) {
      let boundary = 0
      for (let i = 0; i < pending.length; i++) {
        const part = pending[i]!
        // 文件名与英文单词留作整体；目录分隔符、空格与宽字符允许断行。
        if (!part.control && (/[\s/\\]/.test(part.text) || part.cells >= 2)) boundary = i + 1
      }
      emit(boundary || pending.length, true)
    }
    pending.push(atom); cells += atom.cells
  }
  const clean = text.split(/(\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/).map(part => part.startsWith('\x1b]8;') ? part : enforceTextContract(part)).join('').replace(/\t/g, '    ')
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const part of clean.split(/(\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\n)/)) {
    if (part === '\n') emit(pending.length, false)
    else if (part.startsWith('\x1b')) append({ text: part, cells: 0, control: true })
    else for (const { segment } of graphemes.segment(part)) {
      append({ text: segment, cells: displayWidth(segment, wide) })
    }
  }
  emit(pending.length, false)
  return rows
}
