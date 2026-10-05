import { UIHistory, historyText, readHistorySource, type UIRecord } from '../ui-history.js'
import { getTheme, getActiveThemeName } from '../theme.js'
import { formatMarkdown, parseBlocks, highlightLine, keywordsForLang, type Block } from '../format/markdown.js'
import { formatToolCard } from '../format/tool-card.js'
import { displayWidth, ambiguousWideEnabled, truncateToDisplayWidth } from '../width.js'
import { useAsciiGlyphs } from '../term-caps.js'
import { ANSI, ANSI_SEQ_RE, color, enforceTextContract } from './ansi.js'
import type { KeyPress } from './input-handler.js'
import { statSync } from 'node:fs'
import { basename, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ConversationAnchor {
  recordId: number
  recordIndex: number
  block: number
  lineOffset: number
}
export interface ViewportCell extends ConversationAnchor { text: string }
type SearchMode = 'closed' | 'query' | 'results'
interface DetailPage { id: number; offsets: number[]; page: number; text: string; next: number; more: boolean; error: string }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const wide = () => ({ ambiguousAsWide: ambiguousWideEnabled() })

/** Wrap styled text in terminal cells without splitting graphemes or emitting external controls. */
export function wrapViewportText(text: string, width: number, continuation = ''): string[] {
  width = Math.max(1, Math.floor(width))
  if (displayWidth(continuation, wide()) >= width - 1) continuation = ''
  const result: string[] = []
  let current = '', styles = '', cells = 0
  const emit = () => { result.push(current + (styles ? ANSI.RESET : '')); current = styles + continuation; cells = displayWidth(continuation, wide()) }
  const clean = enforceTextContract(text).replace(/\t/g, '    ')
  let pos = 0
  // eslint-disable-next-line no-control-regex
  for (const match of clean.matchAll(/\x1b\[[\d;]*m|\n/g)) {
    append(clean.slice(pos, match.index))
    if (match[0] === '\n') emit()
    else { current += match[0]; styles = match[0] === ANSI.RESET ? '' : styles + match[0] }
    pos = match.index + match[0].length
  }
  append(clean.slice(pos))
  result.push(current + (styles ? ANSI.RESET : ''))
  return result

  function append(part: string) {
    for (const { segment } of graphemes.segment(part)) {
      const n = displayWidth(segment, wide())
      if (n > width) continue
      if (cells + n > width && cells) emit()
      current += segment
      cells += n
    }
  }
}

function markdownSource(block: Block): string {
  switch (block.type) {
    case 'code': return `\`\`\`${block.language ?? ''}\n${block.content}\n\`\`\``
    case 'header': return `${'#'.repeat(block.level ?? 1)} ${block.content}`
    case 'blockquote': return block.content.split('\n').map(line => `> ${line}`).join('\n')
    case 'list': return (block.items ?? []).map((line, i) => `${block.itemPrefixes?.[i] ?? (block.ordered ? `${i + 1}. ` : '- ')}${line}`).join('\n')
    case 'math': return `$$${block.content}$$`
    case 'hr': return '---'
    default: return block.content
  }
}

/** Disk-backed reading state. Only the anchor page and its two neighbors retain payloads. */
export class ConversationViewport {
  private records = new Map<number, UIRecord>()
  private width = 80
  private height = 20
  private loadedCount = -1
  private pending: Promise<void> = Promise.resolve()
  private searchPending: Promise<void> = Promise.resolve()
  private controller?: AbortController
  private searchMode: SearchMode = 'closed'
  private query = ''
  private matches: number[] = []
  private matchIndex = -1
  private priorAnchor?: ConversationAnchor
  private priorFollow = false
  private priorDetail?: DetailPage
  private priorProcess?: { start: number; end: number }
  private following = true
  private observedCount = 0
  private streaming = false
  private detail?: DetailPage
  private readingEpoch = 0
  private expandedProcess?: { start: number; end: number }
  private position: ConversationAnchor = { recordId: 0, recordIndex: 0, block: 0, lineOffset: 0 }
  private cells: ViewportCell[] = []
  private failure = ''
  private preparing = false
  private blockCache = new Map<number, string[][]>()
  private cacheAppearance = ''

  constructor(readonly history: UIHistory, private readonly onChange: () => void) { this.observedCount = history.count }

  get anchor(): ConversationAnchor { return { ...this.position } }
  get follow(): boolean { return this.following }
  get residentRecords(): number { return this.records.size }
  get visibleCells(): readonly ViewportCell[] { return this.cells }
  get detailBytes(): number { return this.detail ? Buffer.byteLength(this.detail.text) : 0 }
  get newRecords(): number { return this.following ? 0 : Math.max(0, this.history.count - this.observedCount) }
  get searchState(): { mode: SearchMode; query: string; matches: number; index: number; pending: boolean } {
    return { mode: this.searchMode, query: this.query, matches: this.matches.length, index: this.matchIndex, pending: !!this.controller }
  }
  get status(): string { return this.readingStatus(false) }
  get inlineStatus(): string { return this.readingStatus(true) }
  private readingStatus(inline: boolean): string {
    if (this.searchMode === 'query') return `/${this.query} · ${this.controller ? '搜索中' : `${this.matches.length}处匹配`} · Enter 结果 · Esc 返回`
    if (this.searchMode === 'results') return `${this.matches.length ? this.matchIndex + 1 : 0}/${this.matches.length}处匹配 · n/N 跳转 · / 编辑 · Esc 原位置`
    const parts = [inline ? 'Enter 展开/收起 · ↑↓ 阅读 · PgUp/PgDn 翻页 · 输入返回对话' : '↑↓/j/k 逐行 · PgUp/PgDn 半屏 · / 搜索 · Esc 返回']
    if (this.newRecords) parts.unshift(`有${this.newRecords}条新记录 · Ctrl+End 回到底部`)
    if (this.streaming) parts.unshift('正在续写')
    if (this.detail) parts.unshift(`详情第${this.detail.page + 1}页 · ←/→ 换页 · Enter 折叠`)
    if (this.failure || this.history.diagnostic) parts.unshift('历史记录异常（见提示）')
    return parts.join(' · ')
  }

  setStreaming(value: boolean): void { this.streaming = value }
  startReading(): void {
    if (this.following) this.observedCount = this.history.count
    this.following = false
  }
  stopReading(): void {
    this.readingEpoch++
    this.controller?.abort()
    this.controller = undefined
    this.searchMode = 'closed'
    this.priorAnchor = undefined
    this.priorDetail = undefined
    this.priorProcess = undefined
    this.detail = undefined
    this.expandedProcess = undefined
    this.blockCache.clear()
    this.following = true
    this.observedCount = this.history.count
    this.schedule(() => this.bottom())
  }

  async settled(): Promise<void> { await this.pending; await this.searchPending; await this.pending }

  private resizeAnchor?: { recordId: number; block: number; lineOffset: number; offset: number }
  private rowContent(text: string): string { return viewportPlainText(text).replace(/^[❯●>] /, '').replace(/^\s*▎ /, '').replace(/\s/g, '') }
  private reflow(width: number): void {
    width = Math.max(1, Math.floor(width))
    if (width === this.width) return
    const record = !this.following && this.records.get(this.position.recordIndex)
    if (!record) { this.width = width; return }
    const before = this.blocks(record)[this.position.block] ?? []
    const saved = this.resizeAnchor
    const offset = saved && saved.recordId === record.id && saved.block === this.position.block && saved.lineOffset === this.position.lineOffset
      ? saved.offset : before.slice(0, this.position.lineOffset).reduce((n, row) => n + this.rowContent(row).length, 0)
    this.width = width
    const after = this.blocks(record)[this.position.block] ?? []
    let used = 0, row = 0
    while (row + 1 < after.length && used + this.rowContent(after[row]!).length <= offset) used += this.rowContent(after[row++]!).length
    this.position.lineOffset = row
    this.resizeAnchor = { recordId: record.id, block: this.position.block, lineOffset: row, offset }
  }

  async prepare(width: number, height: number): Promise<void> {
    this.reflow(width)
    this.height = Math.max(1, Math.floor(height))
    if (this.following) await this.bottom()
    else await this.load(this.position.recordIndex)
    this.normalize()
  }

  render(width: number, height: number): string[] {
    const needs = this.width !== width || this.height !== height || this.loadedCount !== this.history.count
    this.reflow(width)
    this.height = Math.max(1, Math.floor(height))
    if (needs && !this.preparing) {
      this.preparing = true
      this.schedule(async () => { try { await this.prepare(width, height) } finally { this.preparing = false } })
    }
    this.normalize()
    const lines: string[] = []
    this.cells = []
    const cursor = { ...this.position }
    while (lines.length < this.height) {
      const record = this.records.get(cursor.recordIndex)
      if (!record) break
      const blocks = this.blocks(record)
      const line = blocks[cursor.block]?.[cursor.lineOffset]
      if (line === undefined) break
      lines.push(line)
      this.cells.push({ ...cursor, text: line })
      if (!this.stepLocal(cursor, 1)) break
    }
    if (!lines.length) lines.push(...wrapViewportText(this.history.count ? '历史正在读取…' : '本会话暂无阅读记录', this.width).slice(0, this.height))
    return lines
  }

  selectRecord(index: number): void {
    this.startReading()
    const epoch = this.readingEpoch
    this.schedule(async () => { await this.load(index); if (epoch === this.readingEpoch) this.setPosition(index, 0, 0) })
  }
  selectCell(cell: ConversationAnchor): void {
    this.startReading()
    this.position = { ...cell }
    this.onChange()
  }

  knownLinkAt(cell: ViewportCell, column: number): string | null {
    const record = this.records.get(cell.recordIndex)
    if (!record || record.id !== cell.recordId) return null
    const candidates: Array<{ label: string; target: string }> = []
    for (const match of record.text.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)) candidates.push({ label: match[1]!, target: match[2]! })
    for (const match of record.text.matchAll(/https?:\/\/[^\s<>)]+/g)) candidates.push({ label: match[0], target: match[0] })
    for (const target of [record.rawPath, record.input?.path, record.input?.file_path, record.input?.url]) {
      if (typeof target !== 'string') continue
      candidates.push({ label: target, target }, { label: basename(target), target })
    }
    const text = viewportPlainText(cell.text)
    const hits = new Set<string>()
    for (const { label, target } of candidates) {
      for (let index = text.indexOf(label); label && index >= 0; index = text.indexOf(label, index + label.length)) {
        const start = displayWidth(text.slice(0, index), wide())
        if (column < start || column >= start + displayWidth(label, wide())) continue
        const safe = trustedLinkTarget(target)
        if (safe) hits.add(safe)
      }
    }
    return hits.size === 1 ? [...hits][0]! : null
  }

  handleKey(key: KeyPress): boolean {
    if (this.searchMode === 'query') {
      if (key.name === 'escape') { this.searchMode = 'results'; this.onChange(); return true }
      if (key.name === 'return') { this.searchMode = 'results'; this.schedule(async () => { await this.searchPending; if (this.searchMode === 'results') await this.jumpMatch(0) }); return true }
      if (key.name === 'backspace') { this.query = Array.from(graphemes.segment(this.query)).slice(0, -1).map(g => g.segment).join(''); this.search(); return true }
      if (key.name === 'ctrl_u') { this.query = ''; this.search(); return true }
      if (key.char && !key.ctrl && !key.meta) { this.query += historyText(key.char).replace(/\n/g, ''); this.search(); return true }
      return false
    }
    if (key.char === '/' && !key.ctrl && !key.meta) {
      if (this.searchMode === 'closed') { this.priorAnchor = { ...this.position }; this.priorFollow = this.following; this.priorDetail = this.detail; this.priorProcess = this.expandedProcess; this.query = ''; this.matches = []; this.matchIndex = -1 }
      this.startReading()
      this.searchMode = 'query'
      this.onChange()
      return true
    }
    if (key.name === 'escape') {
      if (this.searchMode !== 'results') return false
      this.controller?.abort(); this.controller = undefined
      this.searchMode = 'closed'
      if (this.detail) this.blockCache.delete(this.detail.id)
      this.detail = this.priorDetail
      this.priorDetail = undefined
      this.expandedProcess = this.priorProcess
      this.priorProcess = undefined
      this.blockCache.clear()
      if (this.priorAnchor) this.position = { ...this.priorAnchor }
      this.following = this.priorFollow
      this.priorAnchor = undefined
      this.schedule(async () => { await this.load(this.position.recordIndex) })
      return true
    }
    if (this.searchMode === 'results' && (key.char === 'n' || key.char === 'N')) {
      this.schedule(async () => { if (this.searchMode === 'results') await this.jumpMatch(key.char === 'N' ? -1 : 1) }); return true
    }
    if (key.ctrl && key.name === 'home') { this.startReading(); this.schedule(async () => { await this.load(0); this.setPosition(0, 0, 0) }); return true }
    if (key.ctrl && key.name === 'end') { this.following = true; this.observedCount = this.history.count; this.schedule(() => this.bottom()); return true }
    if (key.name === 'return') { const epoch = this.readingEpoch; this.schedule(() => this.toggleDetail(epoch)); return true }
    if (this.detail && (key.name === 'right' || key.name === 'left' || key.char === ']' || key.char === '[')) {
      this.schedule(() => this.pageDetail(key.name === 'left' || key.char === '[' ? -1 : 1)); return true
    }
    if (key.name === 'home' || key.name === 'end') {
      this.startReading()
      this.schedule(async () => {
        await this.load(this.position.recordIndex)
        const blocks = this.blocks(this.records.get(this.position.recordIndex)!)
        this.setPosition(this.position.recordIndex, key.name === 'end' ? blocks.length - 1 : 0, key.name === 'end' ? blocks.at(-1)!.length - 1 : 0)
        if (key.name === 'end') {
          for (let i = 1; i < this.height; i++) {
            const previous = { ...this.position }
            if (!this.stepLocal(previous, -1) || previous.recordId !== this.position.recordId) break
            this.position = previous
          }
        }
      })
      return true
    }
    const movement = key.name === 'up' || key.char === 'k' ? -1
      : key.name === 'down' || key.char === 'j' ? 1
      : key.name === 'pageup' ? -Math.max(1, Math.floor(this.height / 2))
      : key.name === 'pagedown' ? Math.max(1, Math.floor(this.height / 2)) : 0
    if (!movement || key.ctrl || key.meta) return false
    this.startReading()
    this.schedule(async () => {
      await this.move(movement)
      if (movement > 0 && this.searchMode === 'closed' && !this.expandedProcess && !this.detail) {
        const cursor = { ...this.position }
        for (let i = 0; i < this.height; i++) {
          if (!this.stepLocal(cursor, 1)) {
            if (cursor.recordIndex === this.history.count - 1) {
              this.following = true; this.observedCount = this.history.count; await this.bottom()
            }
            break
          }
        }
      }
    })
    return true
  }

  private schedule(action: () => Promise<void>): void {
    this.pending = this.pending.then(action).catch(error => { this.failure = `历史读取失败：${error instanceof Error ? error.message : String(error)}` }).then(() => this.onChange())
  }
  private async load(index: number): Promise<void> {
    index = Math.max(0, Math.min(Math.max(0, this.history.count - 1), index))
    if (this.loadedCount === this.history.count && this.records.has(index)) return
    const start = Math.max(0, Math.floor(index / 64) * 64 - 64)
    const count = this.history.count
    const page = await this.history.page(start, 192)
    this.records = new Map(page.map((r, i) => [start + i, r]))
    this.blockCache.clear()
    this.loadedCount = count
  }
  private setPosition(index: number, block: number, lineOffset: number): void {
    this.resizeAnchor = undefined
    this.position = { recordId: this.records.get(index)?.id ?? 0, recordIndex: index, block, lineOffset }
    this.normalize()
  }
  private normalize(): void {
    let record = this.records.get(this.position.recordIndex)
    if (!record) return
    const group = this.processGroup(this.position.recordIndex)
    if (group && !this.processExpanded(group) && this.position.recordIndex !== group.start) {
      this.position.recordIndex = group.start; this.position.block = 0; this.position.lineOffset = 0
      record = this.records.get(group.start)!
    }
    const blocks = this.blocks(record)
    this.position.recordId = record.id
    this.position.block = Math.max(0, Math.min(blocks.length - 1, this.position.block))
    this.position.lineOffset = Math.max(0, Math.min(blocks[this.position.block]!.length - 1, this.position.lineOffset))
  }
  private blocks(record: UIRecord): string[][] {
    const appearance = `${this.width}:${getActiveThemeName()}:${ambiguousWideEnabled()}`
    if (appearance !== this.cacheAppearance) { this.blockCache.clear(); this.cacheAppearance = appearance }
    const cached = this.blockCache.get(record.id)
    if (cached) return cached
    const index = [...this.records].find(entry => entry[1].id === record.id)?.[0] ?? -1
    const group = this.processGroup(index)
    let result: string[][]
    if (group && !this.processExpanded(group) && index !== group.start) result = []
    else {
      result = this.renderBlocks(record)
      if (group && index === group.start) {
        let tools = 0, thoughts = 0
        for (let i = group.start; i <= group.end; i++) {
          if (this.records.get(i)?.kind === 'tool') tools++
          else thoughts++
        }
        const expanded = this.processExpanded(group)
        const marker = useAsciiGlyphs() ? expanded ? '-' : '+' : expanded ? '▾' : '▸'
        const historyFailure = record.kind === 'error'
        const label = historyFailure ? `历史记录${record.name === 'history-corrupt' ? '损坏' : '不可用'} · ${group.end - group.start + 1} 条` : `执行过程 · ${tools} 工具 · ${thoughts} 思考`
        const summary = color(`${marker} ${label} [${expanded ? '收起' : '展开'}]`, historyFailure ? getTheme().error : getTheme().muted)
        result = [wrapViewportText(summary, this.width), ...(expanded ? result : [])]
      }
    }
    this.blockCache.set(record.id, result)
    return result
  }
  private processGroup(index: number): { start: number; end: number } | undefined {
    const record = this.records.get(index)
    const historyFailure = record?.kind === 'error' && ['history-corrupt', 'history-unavailable'].includes(record.name ?? '')
    const foldable = (candidate?: UIRecord) => historyFailure ? candidate?.kind === 'error' && candidate.name === record.name : candidate?.kind === 'thinking' || candidate?.kind === 'tool' && !candidate.isError && !['ask_user_question', 'team_orchestrate', 'council_convene'].includes(candidate.name ?? '')
    if (!foldable(this.records.get(index))) return
    // Keep group discovery inside one payload page; long runs remain paged and bounded.
    const page = Math.floor(index / 64) * 64
    let start = index, end = index
    while (start > page && foldable(this.records.get(start - 1))) start--
    while (end < page + 63 && foldable(this.records.get(end + 1))) end++
    return end > start ? { start, end } : undefined
  }
  private processExpanded(group: { start: number; end: number }): boolean { return this.expandedProcess?.start === group.start }
  private disclosureTitle(text: string, expanded: boolean): string {
    const action = ` [${expanded ? '收起' : '展开'}]`
    const width = Math.max(0, this.width - displayWidth(action, wide()))
    const label = historyText(text).split('\n')[0] ?? ''
    return truncateToDisplayWidth(label, Math.max(0, width - (displayWidth(label, wide()) > width ? 1 : 0)), wide()) + (displayWidth(label, wide()) > width ? '…' : '') + action
  }
  private renderBlocks(record: UIRecord): string[][] {
    const theme = getTheme()
    const wrap = (lines: string[], width = this.width, hanging = false) => lines.flatMap(line => {
      const prefix = hanging ? line.replace(ANSI_SEQ_RE, '').match(/^(?:\d+\.|◇|▎) /)?.[0] ?? '' : ''
      return wrapViewportText(line, width, prefix.startsWith('▎') ? prefix : ' '.repeat(displayWidth(prefix, wide())))
    })
    if (record.kind === 'tool') {
      const card = formatToolCard({ toolName: record.name ?? 'tool', content: '', isError: record.isError, toolInput: record.input, rawPath: record.rawPath }, theme)
      const title = wrap([color(this.disclosureTitle(card[0] ?? record.name ?? 'tool', this.detail?.id === record.id), record.isError ? theme.error : theme.secondary)])
      if (this.detail?.id !== record.id) return record.isError ? [title, wrap([historyText(record.text).split('\n')[0] ?? ''])] : [title]
      return [title, wrap(['参数', JSON.stringify(record.input ?? {}, null, 2)]), ...this.detailBlocks(record)]
    }
    if (record.kind === 'thinking' && this.detail?.id !== record.id) return [wrap([color('思考（已记录） [展开]', theme.dim)])]
    if (record.kind === 'notice' && record.name !== 'turn-complete' && (this.detail?.id === record.id || wrap([record.text]).length > 1)) {
      const label = /暂停保存|历史保存失败/.test(record.text) ? '提示 · 历史保存已暂停' : `提示 · ${record.text}`
      const title = wrap([color(this.disclosureTitle(label, this.detail?.id === record.id), theme.warning)])
      return this.detail?.id === record.id ? [title, ...this.detailBlocks(record)] : [title]
    }
    const labels = { user: useAsciiGlyphs() ? '>' : '❯', assistant: '●', thinking: '思考', approval: '等待审批', error: '错误', boundary: '会话边界', notice: '提示' }
    const tint = record.kind === 'error' ? theme.error : record.kind === 'notice' ? theme.warning : record.kind === 'user' ? theme.userColor : record.kind === 'assistant' ? theme.assistantColor : theme.dim
    const conversation = record.kind === 'user' || record.kind === 'assistant'
    if (record.kind === 'notice' && record.name === 'turn-complete') return [wrap([color(record.text, theme.muted)])]
    const role = labels[record.kind]
    const out: string[][] = conversation ? [] : [wrap([color(labels[record.kind] + (record.rawPath ? ' · Enter 查看全文' : ''), tint)])]
    if (this.detail?.id === record.id) out.push(...this.detailBlocks(record))
    else {
      const source = historyText(record.text)
      for (const block of parseBlocks(source)) {
        const width = Math.max(1, this.width - (conversation ? 2 : 0))
        let lines: string[]
        if (block.type === 'code') {
          const language = block.language ? keywordsForLang(block.language) : null
          lines = [color(block.language ?? 'code', theme.muted), ...block.content.split('\n').map(line =>
            highlightLine(line, language?.keywords ?? null, language?.caseInsensitive ?? false, theme).map(segment =>
              segment.color ? color(segment.text, segment.color, { bold: segment.bold }) : segment.text).join(''))]
        } else if (block.type === 'blockquote') lines = block.content.split('\n').map(line => `${color('▎', theme.secondary)} ${color(line, theme.muted, { italic: true })}`)
        else lines = formatMarkdown({ text: markdownSource(block), columns: width }, theme)
        const rows = wrap(lines.length ? lines : [''], width, block.type === 'list' || block.type === 'blockquote')
        if (conversation) {
          const first = !out.length
          if (!first) out.push([''])
          out.push(rows.map((line, index) => `${first && index === 0 ? color(role, tint) + ' ' : '  '}${line}`))
        } else out.push(rows)
      }
      if (!source) out.push([''])
    }
    out.push([''])
    return out
  }
  private detailBlocks(record: UIRecord): string[][] {
    const d = this.detail!
    const lines = d.error ? [d.error, record.text] : [d.more ? '结果（分页）· 后续 →' : '结果', d.text]
    return lines.map(text => wrapViewportText(text, this.width))
  }
  private stepLocal(cursor: ConversationAnchor, direction: number): boolean {
    const r = this.records.get(cursor.recordIndex)
    if (!r) return false
    const blocks = this.blocks(r)
    if (direction > 0) {
      if (blocks.length && cursor.lineOffset + 1 < blocks[cursor.block]!.length) cursor.lineOffset++
      else if (cursor.block + 1 < blocks.length) { cursor.block++; cursor.lineOffset = 0 }
      else {
        do {
          if (cursor.recordIndex + 1 >= this.history.count || !this.records.has(cursor.recordIndex + 1)) return false
          cursor.recordIndex++
        } while (!this.blocks(this.records.get(cursor.recordIndex)!).length)
        cursor.recordId = this.records.get(cursor.recordIndex)!.id; cursor.block = 0; cursor.lineOffset = 0
      }
    } else {
      if (cursor.lineOffset > 0) cursor.lineOffset--
      else if (cursor.block > 0) { cursor.block--; cursor.lineOffset = blocks[cursor.block]!.length - 1 }
      else {
        do {
          if (cursor.recordIndex <= 0 || !this.records.has(cursor.recordIndex - 1)) return false
          cursor.recordIndex--
        } while (!this.blocks(this.records.get(cursor.recordIndex)!).length)
        cursor.recordId = this.records.get(cursor.recordIndex)!.id
        const previous = this.blocks(this.records.get(cursor.recordIndex)!)
        cursor.block = previous.length - 1; cursor.lineOffset = previous[cursor.block]!.length - 1
      }
    }
    return true
  }
  private async move(amount: number, minimumIndex = 0): Promise<void> {
    this.resizeAnchor = undefined
    const direction = Math.sign(amount)
    for (let n = 0; n < Math.abs(amount); n++) {
      await this.load(this.position.recordIndex)
      this.normalize()
      const cursor = { ...this.position }
      if (!this.stepLocal(cursor, direction)) {
        const next = cursor.recordIndex + direction
        if (next < minimumIndex || next >= this.history.count) break
        await this.load(next)
        if (!this.stepLocal(cursor, direction)) break
      }
      if (cursor.recordIndex < minimumIndex) break
      this.position = cursor
    }
  }
  private async bottom(): Promise<void> {
    const index = Math.max(0, this.history.count - 1)
    await this.load(index)
    const record = this.records.get(index)
    if (!record) return
    const blocks = this.blocks(record)
    this.setPosition(index, Math.max(0, blocks.length - 1), blocks.at(-1)?.length ? blocks.at(-1)!.length - 1 : 0)
    await this.move(-Math.max(0, this.height - 1), Math.max(0, Math.floor(index / 64) * 64 - 64))
    if (this.following) this.observedCount = this.history.count
  }
  private search(): void {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const query = this.query
    this.searchPending = this.history.search(query, controller.signal).then(hits => {
      if (controller.signal.aborted || this.controller !== controller) return
      this.matches = hits; this.matchIndex = -1; this.controller = undefined; this.onChange()
    }).catch(error => {
      if (controller.signal.aborted) return
      this.failure = `搜索失败：${String(error)}`; this.controller = undefined; this.onChange()
    })
    this.onChange()
  }
  private async jumpMatch(direction: number): Promise<void> {
    if (!this.matches.length) return
    this.matchIndex = direction === 0 ? 0 : (this.matchIndex + direction + this.matches.length) % this.matches.length
    const index = this.matches[this.matchIndex]!
    await this.load(index)
    if (this.searchMode !== 'results') return
    const record = this.records.get(index)
    if (!record) return
    this.expandedProcess = this.processGroup(index)
    this.blockCache.clear()
    const needle = this.query.replace(/\s/g, '').toLowerCase()
    const locate = (): boolean => {
      this.blockCache.delete(record.id)
      const blocks = this.blocks(record)
      for (const [block, rows] of blocks.entries()) {
        const values = rows.map(row => this.rowContent(row).toLowerCase())
        const offset = values.join('').indexOf(needle)
        if (offset < 0) continue
        let used = 0, row = 0
        while (row + 1 < values.length && used + values[row]!.length <= offset) used += values[row++]!.length
        this.setPosition(index, block, row)
        return true
      }
      return false
    }
    if (needle && locate()) return
    if (this.detail) this.blockCache.delete(this.detail.id)
    const detail: DetailPage = { id: record.id, offsets: [0], page: 0, text: '', next: 0, more: false, error: '' }
    this.detail = detail
    let carry = ''
    do {
      this.readDetail(record)
      const text = detail.text
      detail.text = carry + text
      if (needle && locate()) return
      carry = this.query.length > 1 ? text.slice(-(this.query.length - 1)) : ''
      if (detail.error || !detail.more || detail.next <= detail.offsets[detail.page]!) break
      detail.offsets[++detail.page] = detail.next
      await new Promise<void>(resolve => setImmediate(resolve))
    } while (this.searchMode === 'results' && this.query.replace(/\s/g, '').toLowerCase() === needle)
    if (this.searchMode === 'results') this.setPosition(index, 0, 0)
  }
  private async toggleDetail(epoch: number): Promise<void> {
    if (epoch !== this.readingEpoch) return
    await this.load(this.position.recordIndex)
    if (epoch !== this.readingEpoch) return
    const record = this.records.get(this.position.recordIndex)
    if (!record) return
    const group = this.processGroup(this.position.recordIndex)
    if (group && (this.position.recordIndex === group.start && this.position.block === 0 || !this.processExpanded(group))) {
      this.expandedProcess = this.processExpanded(group) ? undefined : group
      this.detail = undefined
      this.blockCache.clear()
      this.position.block = 0; this.position.lineOffset = 0
      this.startReading()
      return
    }
    if (record.kind !== 'tool' && record.kind !== 'thinking' && record.kind !== 'notice' && !record.rawPath) return
    if (this.detail) this.blockCache.delete(this.detail.id)
    if (this.detail?.id === record.id) this.detail = undefined
    else {
      this.detail = { id: record.id, offsets: [0], page: 0, text: '', next: 0, more: false, error: '' }
      this.readDetail(record)
    }
    this.blockCache.delete(record.id)
    this.position.block = 0; this.position.lineOffset = 0
    this.startReading()
  }
  private readDetail(record: UIRecord): void {
    const d = this.detail!
    if (!record.rawPath) {
      d.text = record.text
      d.error = /显示预览|全文不可用/.test(record.text) || record.text.length >= 6000 ? '全文不可用：仅保留历史预览' : ''
      return
    }
    try {
      const source = readHistorySource(record.rawPath, d.offsets[d.page]!, 16384)
      d.text = source.text; d.next = source.next; d.more = source.more; d.error = ''
    } catch { d.text = ''; d.more = false; d.error = '全文不可用：原始来源已丢失或无法读取' }
  }
  private async pageDetail(direction: number): Promise<void> {
    const d = this.detail
    if (!d || (direction < 0 && !d.page) || (direction > 0 && !d.more)) return
    const record = this.records.get(this.position.recordIndex)
    if (!record || record.id !== d.id || !record.rawPath) return
    if (direction > 0) { d.offsets[d.page + 1] = d.next; d.page++ } else d.page--
    this.readDetail(record)
    this.blockCache.delete(record.id)
    this.position.block = 0; this.position.lineOffset = 0
  }
}

/** Cell-safe plain text for explicit selection and clipboard consumers. */
export function viewportPlainText(text: string): string { return enforceTextContract(text).replace(ANSI_SEQ_RE, '') }
export function viewportCellSlice(text: string, start: number, end: number): string {
  let result = '', cell = 0
  for (const { segment } of graphemes.segment(viewportPlainText(text))) {
    const width = displayWidth(segment, wide())
    if (cell < end && cell + width > start) result += segment
    cell += width
  }
  return result
}

export function viewportHighlightCells(text: string, start: number, end: number): string {
  let result = '', cell = 0, selected = false
  for (const { segment } of graphemes.segment(viewportPlainText(text))) {
    const width = displayWidth(segment, wide())
    const hit = cell < end && cell + width > start
    if (hit !== selected) { result += hit ? ANSI.REVERSE : ANSI.RESET; selected = hit }
    result += segment
    cell += width
  }
  return result + (selected ? ANSI.RESET : '')
}

function trustedLinkTarget(target: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!target || /[\r\n\0]/.test(target) || /^(?:\\\\|\/\/)/.test(target)) return null
  if (/^https?:\/\//i.test(target)) {
    try { const url = new URL(target); return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null } catch { return null }
  }
  if (/^file:/i.test(target)) {
    try {
      const url = new URL(target)
      if (url.hostname && url.hostname !== 'localhost') return null
      target = fileURLToPath(url)
    } catch { return null }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null
  if (/^(?:\\\\|\/\/)/.test(target)) return null
  const path = resolve(target)
  if (/^\.(?:exe|cmd|bat|com|msi|lnk|url|scf|scr|cpl|hta|ps1|vbs|vbe|wsf|wsh|desktop|app)$/i.test(extname(path))) return null
  try { return statSync(path).isFile() ? path : null } catch { return null }
}
