/**
 * Collapsed Bash Group — 将连续短/非变更型 bash 命令折叠为单行摘要。
 *
 * 触发条件：命令长度 ≤ MAX_COMMAND_LEN 且不命中变更型模式（重定向、rm、cp、git push…）。
 * 连续可折叠 bash 合并为 "Ran N shell commands"；被非 bash 工具、变更型 bash、
 * 或错误结果打断时 flush。
 *
 * 温跃层设计：CollapsedBashBuffer（状态管理）↔ app.ts（事件驱动）。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { ambiguousWideEnabled, displayWidth, truncateToDisplayWidth } from '../width.js'
import { formatToolCard } from './tool-card.js'
import { EXPAND_HINT } from '../truncation-marker.js'

// ── Types ──────────────────────────────────────────────────────

export interface CollapsedBashEntry {
  /** tool_use_id */
  id: string
  /** 原始命令 */
  command: string
  /** 输出内容（终态） */
  rawPath?: string
  content?: string
  /** 是否执行失败 */
  isError?: boolean
  /** 终态结果已到达 */
  completed: boolean
  /** 命令开始时间 */
  startMs: number
}

export interface CollapsedBashGroup {
  entries: CollapsedBashEntry[]
  startMs: number
}

// ── Heuristics ─────────────────────────────────────────────────

/** 可折叠命令的最大长度（字符） */
export const MAX_COLLAPSIBLE_COMMAND_LEN = 200

/**
 * 变更型命令/模式。命中任一模式即视为可能修改文件系统/远程状态，不折叠。
 * 设计原则：宁可漏折叠（false negative）也不误折叠变更命令（false positive）。
 */
const MUTATING_PATTERNS: ReadonlyArray<RegExp> = [
  // 输出重定向（>、>>、>&，后接空白或行尾）
  />[&>]*(?:\s|$)/,
  // 文件系统变更
  /\b(rm|cp|mv|mkdir|rmdir|touch|chmod|chown|ln|tee|dd)\b/,
  // git 变更
  /\bgit\s+(commit|push|pull|checkout|merge|rebase|reset|cherry-pick|revert|apply)\b/,
  // 包管理器变更
  /\b(npm|yarn|pnpm|bun)\s+(install|ci|publish|uninstall|remove|add)\b/,
  // sed 就地编辑
  /\bsed\s+(-i|--in-place)\b/,
  // find 删除/执行（-ok 也算执行）
  /\bfind\s+.*(-delete|-exec|-ok)\b/,
  // 构建工具（常写文件）
  /\bmake\b/,
  /\btsc\s+(--build|-b)\b/,
]

/** 判断单个 bash 命令是否可折叠（短且非变更） */
export function isCollapsibleBashCommand(command: string): boolean {
  const trimmed = (command ?? '').trim()
  if (!trimmed) return false
  if (trimmed.length > MAX_COLLAPSIBLE_COMMAND_LEN) return false
  const lower = trimmed.toLowerCase()
  return !MUTATING_PATTERNS.some(p => p.test(lower))
}

// ── Summary ────────────────────────────────────────────────────

export interface BashGroupStats {
  total: number
  completed: number
  pending: number
  failed: number
}

export function computeBashGroupStats(group: CollapsedBashGroup): BashGroupStats {
  let completed = 0
  let pending = 0
  let failed = 0
  for (const entry of group.entries) {
    if (entry.completed) {
      completed++
      if (entry.isError) failed++
    } else {
      pending++
    }
  }
  return { total: group.entries.length, completed, pending, failed }
}

export function buildBashSummaryText(group: CollapsedBashGroup, isActive?: boolean): string {
  const stats = computeBashGroupStats(group)
  if (stats.completed === 0) {
    const parts: string[] = ['…']
    if (isActive && stats.pending > 0) parts.push(`${stats.pending} pending`)
    return parts.join(', ')
  }
  const base = `Ran ${stats.completed} shell command${stats.completed === 1 ? '' : 's'}`
  const parts: string[] = [base]
  if (stats.failed > 0) parts.push(`${stats.failed} failed`)
  if (isActive && stats.pending > 0) parts.push(`${stats.pending} pending`)
  return parts.join(', ')
}

export function buildBashLiveSummaryText(group: CollapsedBashGroup): string {
  const stats = computeBashGroupStats(group)
  if (stats.pending > 0) {
    return `Running ${stats.pending} shell command${stats.pending === 1 ? '' : 's'}`
  }
  return buildBashSummaryText(group, true)
}

// ── Rendering: scrollback ──────────────────────────────────────

export interface FormatCollapsedBashGroupInput {
  group: CollapsedBashGroup
  expanded?: boolean
  theme: RivetTheme
  columns?: number
  expandHint?: string
}

export function formatCollapsedBashGroup(input: FormatCollapsedBashGroupInput): string[] {
  const { group, expanded, theme } = input
  const width = Math.max(2, (input.columns ?? 80) - 1)
  const widthOptions = { ambiguousAsWide: ambiguousWideEnabled() }
  const fit = (line: string) => displayWidth(line, widthOptions) > width
    ? truncateToDisplayWidth(line, width - displayWidth('…', widthOptions), widthOptions) + '…' : line
  const elapsed = Math.max(0, Date.now() - group.startMs)
  const elapsedStr = elapsed > 1000 ? (elapsed / 1000).toFixed(1) + 's' : elapsed + 'ms'
  const completed = group.entries.filter(entry => entry.completed)
  const lines = group.entries.length > 1
    ? [fit(color(buildBashSummaryText(group, false) + ' · ' + elapsedStr, theme.muted))] : []
  if (!completed.length) return [fit(color('Run · 等待结果', theme.muted))]
  const shown = expanded ? completed : completed.filter((entry, index) => index < 3 || entry.isError)
  for (const entry of shown) {
    const allLines = (entry.content ?? '').replace(/\n+$/, '').split('\n')
    const card = formatToolCard({
      toolName: 'bash', toolInput: { command: entry.command }, content: entry.content ?? '', rawPath: entry.rawPath, isError: entry.isError,
      columns: input.columns, maxLines: 3, expanded, expandHint: input.expandHint,
    }, theme)
    if (expanded) lines.push(...card)
    else {
      lines.push(card[0]!)
      if (entry.rawPath) lines.push(fit(color(`  全文来源: ${entry.rawPath}`, theme.muted)))
      if (entry.isError || completed.length === 1) {
        const preview = entry.isError ? allLines.slice(-3) : allLines.slice(0, 2)
        lines.push(...preview.filter(Boolean).map(row => fit(`  ${color(row, entry.isError ? theme.error : theme.muted)}`)))
      }
    }
  }
  if (!expanded && (completed.length > 1 || completed.some(entry => (entry.content ?? '').split('\n').length > 2))) {
    lines.push(fit(color(`  ${shown.length < completed.length ? `… +${completed.length - shown.length} 条命令 · ` : ''}${input.expandHint ?? EXPAND_HINT} · 工具详情`, theme.muted)))
  }
  return lines
}

// ── Rendering: live region ─────────────────────────────────────

export function formatCollapsedBashGroupLive(
  group: CollapsedBashGroup,
  theme: RivetTheme,
  columns?: number,
): string[] {
  const lines: string[] = []
  const summary = buildBashLiveSummaryText(group)
  const elapsed = Date.now() - group.startMs
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(0)}s` : `${elapsed}ms`
  const width = Math.max(2, (columns ?? 80) - 1)
  const widthOptions = { ambiguousAsWide: ambiguousWideEnabled() }
  const stats = computeBashGroupStats(group)
  const header = `● ${summary} · ${elapsedStr}`
  lines.push(color(displayWidth(header, widthOptions) <= width ? header : `● ${stats.pending ? `运行中 ${stats.pending}` : `完成 ${stats.completed}`} · ${elapsedStr}`, theme.muted))

  const lastCompleted = [...group.entries].reverse().find(e => e.content && e.completed && !e.isError)
  if (lastCompleted?.content) {
    const maxWidth = Math.max(0, width - 2)
    const tailLines = lastCompleted.content.replace(/\n+$/, '').split('\n').slice(-2)
    for (const line of tailLines) {
      const trimmed = displayWidth(line, widthOptions) > maxWidth ? truncateToDisplayWidth(line, maxWidth - displayWidth('…', widthOptions), widthOptions) + '…' : line
      lines.push(`  ${color(trimmed, theme.muted)}`)
    }
  }

  return lines
}

// ── Buffer ─────────────────────────────────────────────────────

export class CollapsedBashBuffer {
  private group: CollapsedBashGroup | null = null

  /** 推入一个可折叠 bash 命令；非折叠命令应在外部判 false 后不调此方法 */
  pushUse(id: string, command: string, startMs: number): void {
    if (!this.group) {
      this.group = { entries: [], startMs }
    }
    this.group.entries.push({ id, command, completed: false, startMs })
  }

  attachResult(id: string, content: string, isError?: boolean, rawPath?: string): CollapsedBashEntry | null {
    if (!this.group) return null
    const entry = this.group.entries.find(e => e.id === id)
    if (!entry) return null
    entry.rawPath = rawPath
    entry.content = content
    entry.isError = isError ?? false
    entry.completed = true
    return entry
  }

  hasEntry(id: string): boolean {
    return this.group?.entries.some(e => e.id === id) ?? false
  }

  /** 将指定 entry 从组中移除并返回（错误命令需单独渲染为 tool card 时使用） */
  detachEntry(id: string): CollapsedBashEntry | null {
    if (!this.group) return null
    const idx = this.group.entries.findIndex(e => e.id === id)
    if (idx === -1) return null
    const [entry] = this.group.entries.splice(idx, 1)
    if (this.group.entries.length === 0) {
      this.group = null
    }
    return entry ?? null
  }

  flush(): CollapsedBashGroup | null {
    const g = this.group
    this.group = null
    return g
  }

  getActive(): CollapsedBashGroup | null {
    return this.group
  }

  isActive(): boolean {
    return this.group !== null
  }

  hasPending(): boolean {
    return this.group?.entries.some(e => !e.completed) ?? false
  }
}
