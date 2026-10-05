import { createReadStream, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { ANSI_SEQ_RE, enforceTextContract } from './engine/ansi.js'
import { declareHistorySource, markHistorySourceUnavailable, prepareHistorySourceAsync, readSafeHistorySource, SENSITIVE_HISTORY_KEY } from './history-source.js'
export { readHistorySource } from './history-source.js'

export interface UIRecordInput {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'approval' | 'error' | 'boundary' | 'notice'
  text: string
  toolId?: string
  name?: string
  input?: Record<string, unknown>
  rawPath?: string
  isError?: boolean
  boundary?: 'compact' | 'resume' | 'rewind' | 'fork' | 'import'
}
export interface UIRecord extends UIRecordInput { id: number; time: number; sourcePath?: string }

const PAGE = 64
const PREVIEW = 6000
const TEXT_KEY = '(?:api[_-]?key|authorization|password|passwd|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret|token)'
const TEXT_CREDENTIAL = new RegExp(`(${TEXT_KEY}["']?\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer\\s+)?[^\\s,;"}&]+)`, 'gi')

function sanitizeHistoryValue(value: unknown): unknown {
  if (typeof value === 'string') return historyText(value)
  if (Array.isArray(value)) return value.map(sanitizeHistoryValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_HISTORY_KEY.test(key.replace(/[^a-z0-9]/gi, '')) ? '***' : sanitizeHistoryValue(child)]))
  return value
}

/** UI records never retain terminal control sequences or common credential forms. */
export function historyText(text: string): string {
  const plain = enforceTextContract(text).replace(ANSI_SEQ_RE, '')
  if (/^\s*[[{]/.test(plain)) {
    try { return JSON.stringify(sanitizeHistoryValue(JSON.parse(plain))) } catch { /* Non-JSON text still receives pattern redaction. */ }
  }
  return plain.replace(/\b(?:sk|rk|ghp|github_pat)[_-][\w-]{8,}/g, '***')
    .replace(TEXT_CREDENTIAL, '$1***')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replace(/\bdata:[^\s"'<>]*?,[^\s"'<>)]*/gi, 'data:[redacted]')
}

function parseHistoryRow(line: string): UIRecord {
  const record = JSON.parse(line) as UIRecord
  if (!record || !Number.isSafeInteger(record.id) || record.id <= 0 || typeof record.text !== 'string' || !['user', 'assistant', 'thinking', 'tool', 'approval', 'error', 'boundary', 'notice'].includes(record.kind)) throw new Error('历史记录格式无效')
  return { ...record, text: historyText(record.text), ...(record.input ? { input: sanitizeHistoryValue(record.input) as Record<string, unknown> } : {}) }
}

function historyPreview(text: string): string {
  const last = text.charCodeAt(PREVIEW - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? PREVIEW - 1 : PREVIEW)
}

/** Sparse disk index + three payload pages. Model compaction cannot rewrite this file. */
export class UIHistory {
  private offsets: number[] = []
  private cache = new Map<number, UIRecord[]>()
  private memory: UIRecord[] = []
  private size = 0
  private bytes = 0
  private sequence = 0
  private failure = ''
  private searchFailure = ''
  private persistedSize = 0
  private needsNewline = false
  private saveFailed = false
  private constructor(readonly path?: string) {}

  static async open(path?: string): Promise<UIHistory> {
    const h = new UIHistory(path)
    if (!path || !existsSync(path)) return h
    try {
      let offset = 0, pending: Buffer = Buffer.alloc(0)
      const accept = (line: Buffer, bytes: number): void => {
        if (h.size % PAGE === 0) h.offsets.push(offset)
        offset += bytes
        try { h.sequence = Math.max(h.sequence, parseHistoryRow(line.toString('utf8')).id) }
        catch { h.failure = '部分历史记录损坏或不完整，已保留不可用占位' }
        h.size++
      }
      for await (const chunk of createReadStream(path)) {
        const buffer = Buffer.concat([pending, chunk as Buffer])
        let start = 0, end: number
        while ((end = buffer.indexOf(10, start)) !== -1) { accept(buffer.subarray(start, end), end - start + 1); start = end + 1 }
        pending = buffer.subarray(start)
      }
      if (pending.length) { accept(pending, pending.length); h.needsNewline = true }
      h.bytes = offset
      h.persistedSize = h.size
    } catch (error) { h.saveFailed = true; h.failure = `历史读取失败，本轮最近 ${PAGE * 2} 条仍可回看：${error instanceof Error ? error.message : String(error)}` }
    h.sequence = Math.max(h.sequence, h.size)
    return h
  }

  get count(): number { return this.size }
  get diagnostic(): string { return [this.failure, this.searchFailure].filter(Boolean).join('；') }
  get cachedRecords(): number { return [...this.cache.values()].reduce((n, p) => n + p.length, 0) + this.memory.length }

  append(input: UIRecordInput): UIRecord {
    const text = historyText(input.text)
    const record: UIRecord = { ...input, text, id: ++this.sequence, time: Date.now() }
    if (input.input) record.input = sanitizeHistoryValue(input.input) as Record<string, unknown>
    try {
      if (this.path && !this.saveFailed) {
        mkdirSync(dirname(this.path), { recursive: true })
        if (text.length > PREVIEW) {
          if (!record.rawPath) {
            record.rawPath = join(dirname(this.path), `ui-output-${record.id}.txt`)
            writeFileSync(record.rawPath, text, { encoding: 'utf8', mode: 0o600 })
          }
          record.text = historyPreview(text) + '\n[显示预览；详情页可读取全文来源]'
        }
        if (input.rawPath) this.routeSource(record)
        const row = JSON.stringify(record) + '\n'
        const prefix = this.needsNewline ? '\n' : ''
        appendFileSync(this.path, prefix + row, { encoding: 'utf8', mode: 0o600 })
        if (this.size % PAGE === 0) this.offsets.push(this.bytes + prefix.length)
        this.bytes += Buffer.byteLength(prefix + row)
        this.needsNewline = false
        this.persistedSize++
      } else {
        // No persistence provider (e.g. embedders): explicitly bounded current-run history.
        record.text = historyPreview(text)
        this.routeSource(record)
      }
    } catch (error) { this.saveFailed = true; record.text = historyPreview(text); this.failure = `历史保存失败，本轮最近 ${PAGE * 2} 条仍可回看；重启后可能缺失：${error instanceof Error ? error.message : String(error)}` }
    this.memory.push(record)
    if (this.memory.length > PAGE * 2) this.memory.shift()
    this.cache.delete(Math.floor(this.size / PAGE))
    this.size++
    return record
  }

  async flush(): Promise<void> { /* Writes settle before append returns. */ }

  async page(start: number, count = PAGE): Promise<UIRecord[]> {
    const records = await this.recordsPage(start, count)
    for (const record of records) {
      const source = record.sourcePath ?? record.rawPath
      if (!source) continue
      try { this.routeSource(record); record.rawPath = (await prepareHistorySourceAsync(source)).path }
      catch { this.failSource(record, source) }
    }
    return records
  }

  private async recordsPage(start: number, count = PAGE): Promise<UIRecord[]> {
    start = Math.max(0, Math.min(this.size, start))
    const end = Math.min(this.size, start + Math.max(0, Math.min(PAGE * 3, count)))
    const out: UIRecord[] = []
    for (let pos = start; pos < end;) {
      const block = Math.floor(pos / PAGE)
      const records = await this.block(block)
      const take = Math.min(end - pos, PAGE - pos % PAGE)
      out.push(...records.slice(pos % PAGE, pos % PAGE + take))
      pos += take
    }
    return out
  }

  private routeSource(record: UIRecord): void {
    const source = record.sourcePath ?? record.rawPath
    if (!source) return
    record.sourcePath = source
    delete record.rawPath
    record.rawPath = declareHistorySource(source)
  }

  private failSource(record: UIRecord, source: string): void {
    record.sourcePath = source
    delete record.rawPath
    try { record.rawPath = markHistorySourceUnavailable(source) }
    catch { if (!record.text.includes('[全文不可用；已脱敏预览仍可阅读]')) record.text += '\n[全文不可用；已脱敏预览仍可阅读]' }
  }

  private async block(block: number): Promise<UIRecord[]> {
    const known = this.cache.get(block)
    if (known) { this.cache.delete(block); this.cache.set(block, known); return known }
    const start = block * PAGE
    // The reader and its validation must refer to the same history snapshot.
    const size = this.size, persistedSize = this.persistedSize
    let records: UIRecord[] = []
    if (this.path && start < this.persistedSize && this.offsets[block] !== undefined) {
      try {
        const stream = createReadStream(this.path, { start: this.offsets[block], ...(this.offsets[block + 1] !== undefined ? { end: this.offsets[block + 1]! - 1 } : {}) })
        const lines = createInterface({ input: stream, crlfDelay: Infinity })
        for await (const line of lines) {
          try { records.push(parseHistoryRow(line)) }
          catch { this.failure = '部分历史记录损坏或不完整，已保留不可用占位'; records.push({ id: -(start + records.length + 1), kind: 'error', name: 'history-corrupt', text: '此历史记录损坏，内容不可用', time: 0 }) }
          if (records.length >= PAGE) { lines.close(); stream.destroy(); break }
        }
      } catch (error) { this.saveFailed = true; this.failure = `历史读取失败，已暂停保存；本轮最近 ${PAGE * 2} 条仍可回看；重启后可能缺失：${error instanceof Error ? error.message : String(error)}` }
    }
    const from = this.size - this.memory.length
    const length = Math.min(PAGE, size - start)
    for (let i = 0; i < length; i++) {
      if (!records[i] && start + i < persistedSize) {
        this.saveFailed = true
        if (!this.failure) this.failure = '历史记录缺失或读取不完整，已暂停保存；重启后新增记录可能缺失'
      }
      const live = this.memory[start + i - from]
      if (live) records[i] = live
      else if (!records[i]) {
        if (!this.failure) this.failure = this.path ? '历史记录缺失或读取不完整，已保留不可用占位' : `暂无持久历史来源，本轮最近 ${PAGE * 2} 条仍可回看`
        records[i] = { id: -(start + i + 1), kind: 'error', name: 'history-unavailable', text: '此历史记录不可用；未保存或读取失败', time: 0 }
      }
    }
    if (length === PAGE || size === this.size) this.cache.set(block, records)
    while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!)
    return records
  }

  /** Search scans pages, yields to input, and cancels when the caller changes query. */
  async search(query: string, signal?: AbortSignal): Promise<number[]> {
    const hits: number[] = []
    const count = this.size, needle = query.toLowerCase()
    let unavailable = 0
    this.searchFailure = ''
    if (!needle || signal?.aborted) return hits
    for (let i = 0; i < count && !signal?.aborted; i += PAGE) {
      const records = await this.recordsPage(i, Math.min(PAGE, count - i))
      for (let j = 0; j < records.length && !signal?.aborted; j++) {
        const record = records[j]!
        const facts = [record.text, historyText(record.name ?? ''), record.input ? JSON.stringify(sanitizeHistoryValue(record.input)) : ''].join('\n')
        let found = facts.toLowerCase().includes(needle)
        const original = record.sourcePath ?? record.rawPath
        if (original) {
          try {
            this.routeSource(record)
            const source = await prepareHistorySourceAsync(original, signal)
            record.rawPath = source.path
            if (source.restricted) this.searchFailure = `${++unavailable} 条记录的全文受限，搜索结果可能不完整`
            let offset = 0, carry = ''
            while (!found && !source.restricted && offset < source.size && !signal?.aborted) {
              const page = readSafeHistorySource(source, offset, Math.min(16_384, source.size - offset))
              if (page.next <= offset) throw new Error('全文来源读取不完整')
              const text = carry + page.text.toLowerCase()
              found = text.includes(needle)
              carry = needle.length > 1 ? text.slice(-(needle.length - 1)) : ''
              offset = page.next
              await new Promise<void>(resolve => setImmediate(resolve))
            }
          } catch {
            if (!signal?.aborted) { this.failSource(record, original); this.searchFailure = `${++unavailable} 条记录的全文来源不可用，搜索结果可能不完整` }
          }
        }
        if (found) hits.push(i + j)
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return signal?.aborted ? [] : hits
  }
}
