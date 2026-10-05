/**
 * Collapsed Read+Search Group — 将连续探索型工具调用折叠为单行摘要。
 *
 * read_file / grep / glob / repo_map / semantic_search 等探索型工具
 * 在连续调用时合并为一个组。非探索型工具（write / edit / bash / delegate）
 * 到达时打断组并 flush 到 scrollback。
 *
 * 温跃层设计：
 *   CollapsedReadSearchBuffer（状态管理）↔ app.ts（事件驱动）
 *   formatCollapsedGroup（scrollback 渲染）↔ formatCollapsedGroupLive（live 聚合）
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { ambiguousWideEnabled, displayWidth, truncateToDisplayWidth } from '../width.js'
import { formatToolCard } from './tool-card.js'
import { EXPAND_HINT } from '../truncation-marker.js'

// ── Types ──────────────────────────────────────────────────────

export type CollapsibleKind = 'read' | 'search' | 'list'

export interface CollapsedReadSearchEntry {
  /** tool_use_id — 唯一标识，并行结果绑定的关键 */
  id: string
  toolName: string
  input: Record<string, unknown>
  displayName: string
  kind: CollapsibleKind
  rawPath?: string
  content?: string
  isError?: boolean
  /** terminal result 已到达 */
  completed: boolean
}

export interface CollapsedReadSearchGroup {
  entries: CollapsedReadSearchEntry[]
  startMs: number
}

// ── Classification ─────────────────────────────────────────────

/**
 * 工具是否可折叠进 read+search 统一组。
 *
 * 覆盖范围（对齐 G2 扩展矩阵）：
 *   read: read_file, read_policy, read_section, file_info
 *   search: grep, glob, semantic_search, repo_map, repo_graph,
 *           related_tests, inspect_project, ls
 *   不可折叠: write_file, edit_file, hash_edit, apply_patch, bash,
 *            run_tests, delegate_*, team_*, todo, recall, web_*, plan_*, 等
 */
export function isCollapsibleTool(toolName: string): boolean {
  return classifyCollapsibleKind(toolName) !== null
}

/** 折叠工具的子分类；非折叠工具返回 null */
export function classifyCollapsibleKind(toolName: string): CollapsibleKind | null {
  const t = toolName.toLowerCase()

  // read 族：读取文件/策略/artifact/元信息
  if (
    t === 'read_file' || t === 'read' || t === 'read-file' ||
    t === 'read_policy' || t === 'read_section' || t === 'file_info'
  ) {
    return 'read'
  }

  // search 族：代码搜索/结构探索
  if (
    t === 'grep' || t === 'glob' || t === 'semantic_search' ||
    t === 'repo_map' || t === 'repo_graph' ||
    t === 'related_tests' || t === 'inspect_project' || t === 'ls' ||
    t === 'ast_grep'
  ) {
    return 'search'
  }

  return null
}

/** 非折叠工具到达时是否应打断当前组 */
export function shouldBreakGroup(toolName: string): boolean {
  return !isCollapsibleTool(toolName)
}

// ── Entry display ──────────────────────────────────────────────

/** 从 tool input 提取可读的展示名（文件名/查询模式/路径） */
export function entryDisplayName(toolName: string, input: Record<string, unknown>): string {
  const t = toolName.toLowerCase()

  // read 族：file_path > file > path
  if (t === 'read_file' || t === 'read' || t === 'read_policy' || t === 'read_section') {
    const path = input.file_path ?? input.file ?? input.path
      ?? (Array.isArray(input.file_paths) ? input.file_paths.join(', ') : '?')
    return typeof path === 'string' ? path : '?'
  }

  // grep：显示 "pattern" in path
  if (t === 'grep') {
    const pattern = input.pattern ?? input.query ?? '?'
    const scope = input.path ?? input.dir ?? ''
    const p = typeof pattern === 'string' ? pattern : '?'
    const s = typeof scope === 'string' && scope ? ` in ${scope}` : ''
    return `"${p}"${s}`
  }

  // glob / semantic_search：显示模式/查询
  if (t === 'glob') {
    const pattern = input.pattern ?? input.query ?? '?'
    return typeof pattern === 'string' ? pattern : '?'
  }
  if (t === 'semantic_search') {
    const query = input.query ?? '?'
    return typeof query === 'string' ? query : '?'
  }

  // ast_grep：显示 "pattern"
  if (t === 'ast_grep') {
    const pattern = input.pattern ?? '?'
    return typeof pattern === 'string' ? pattern : '?'
  }

  // file_info / ls：显示路径
  if (t === 'file_info' || t === 'ls') {
    const path = input.path ?? input.file_path ?? input.dir ?? '.'
    return typeof path === 'string' ? path : '.'
  }

  // repo_map / repo_graph / inspect_project / related_tests：显示路径/文件
  if (t === 'repo_map' || t === 'repo_graph' || t === 'inspect_project' || t === 'related_tests') {
    const path = input.path ?? input.from_file ?? input.file ?? '.'
    return typeof path === 'string' ? path : '.'
  }

  return toolName
}

// ── Entry lookup ───────────────────────────────────────────────

/** 在组中按 toolUseId 查找 entry（O(n)，n 通常 < 10） */
export function findEntryById(
  group: CollapsedReadSearchGroup,
  id: string,
): CollapsedReadSearchEntry | null {
  return group.entries.find(e => e.id === id) ?? null
}

/** 将 terminal result 绑定到对应 entry */
export function attachResult(
  group: CollapsedReadSearchGroup,
  id: string,
  content: string,
  isError?: boolean,
  rawPath?: string,
): CollapsedReadSearchEntry | null {
  const entry = findEntryById(group, id)
  if (!entry) return null
  entry.rawPath = rawPath
  entry.content = content
  entry.isError = isError ?? false
  entry.completed = true
  return entry
}

// ── Summary (computed, no stored counters) ─────────────────────

export interface GroupStats {
  searchCount: number
  readFilePaths: string[]
  listCount: number
  completedCount: number
  pendingCount: number
}

/**
 * 从 entries 实时计算统计（不存储可变计数器，避免 sync 问题）。
 * 仅统计 completed entry。
 */
export function computeGroupStats(group: CollapsedReadSearchGroup): GroupStats {
  let searchCount = 0
  const readFilePaths = new Set<string>()
  let listCount = 0
  let completedCount = 0
  let pendingCount = 0

  for (const entry of group.entries) {
    if (entry.completed) {
      completedCount++
      switch (entry.kind) {
        case 'search':
          searchCount++
          break
        case 'read':
          readFilePaths.add(entry.displayName)
          break
        case 'list':
          listCount++
          break
      }
    } else {
      pendingCount++
    }
  }

  return {
    searchCount,
    readFilePaths: [...readFilePaths],
    listCount,
    completedCount,
    pendingCount,
  }
}

/** 构建组摘要文本（用于 scrollback 标题和 live 聚合行）。
 *  时态：isActive（live 进行中）用进行体（Searching/Reading/Listing），
 *  settled（scrollback 落版）用过去时（Searched/Read/Listed）——
 *  grok verb-group 对标：同一组从"正在发生"平滑过渡到"已发生"。 */
export function buildSummaryText(group: CollapsedReadSearchGroup, isActive?: boolean): string {
  const stats = computeGroupStats(group)
  const parts: string[] = []

  if (stats.searchCount > 0) {
    const n = `${stats.searchCount} pattern${stats.searchCount > 1 ? 's' : ''}`
    parts.push(isActive ? `Searching ${n}` : `Searched ${n}`)
  }
  if (stats.readFilePaths.length > 0) {
    const n = `${stats.readFilePaths.length} file${stats.readFilePaths.length > 1 ? 's' : ''}`
    parts.push(isActive ? `Reading ${n}` : `Read ${n}`)
  }
  if (stats.listCount > 0) {
    const n = `${stats.listCount} dir${stats.listCount > 1 ? 's' : ''}`
    parts.push(isActive ? `Listing ${n}` : `Listed ${n}`)
  }

  if (isActive && stats.pendingCount > 0) {
    parts.push(`${stats.pendingCount} pending`)
  }

  return parts.length > 0 ? parts.join(', ') : '…'
}

// ── Rendering: scrollback ──────────────────────────────────────

export interface FormatCollapsedGroupInput {
  group: CollapsedReadSearchGroup
  expanded?: boolean
  theme: RivetTheme
  columns?: number
  expandHint?: string
}

/** 渲染折叠的 read+search 组（用于 scrollback） */
export function formatCollapsedGroup(input: FormatCollapsedGroupInput): string[] {
  const { group, expanded, theme } = input
  const width = Math.max(2, (input.columns ?? 80) - 1)
  const widthOptions = { ambiguousAsWide: ambiguousWideEnabled() }
  const fit = (line: string) => displayWidth(line, widthOptions) > width
    ? truncateToDisplayWidth(line, width - displayWidth('…', widthOptions), widthOptions) + '…' : line
  const completed = group.entries.filter(entry => entry.completed)
  const elapsed = Math.max(0, Date.now() - group.startMs)
  const elapsedStr = elapsed > 1000 ? (elapsed / 1000).toFixed(1) + 's' : elapsed + 'ms'
  const lines = group.entries.length > 1
    ? [fit(color(buildSummaryText(group, false) + ' · ' + elapsedStr, theme.muted))] : []
  if (!completed.length) return [fit(color('Read/Search · 等待结果', theme.muted))]
  const shown = expanded ? completed : completed.filter((entry, index) => index < 3 || entry.isError)
  for (const entry of shown) {
    const card = formatToolCard({
      toolName: entry.toolName, toolInput: entry.kind === 'read' && !entry.input.file_path && !entry.input.path ? { ...entry.input, file_path: entry.displayName } : entry.input, content: entry.content ?? '',
      rawPath: entry.rawPath, isError: entry.isError, columns: input.columns, maxLines: 3, expanded,
      expandHint: input.expandHint,
    }, theme)
    if (expanded) lines.push(...card)
    else {
      lines.push(card[0]!)
      if (entry.rawPath) lines.push(fit(color(`  全文来源: ${entry.rawPath}`, theme.muted)))
      if (entry.isError || completed.length === 1) {
        const rows = (entry.content ?? '').replace(/\n+$/, '').split('\n')
        const preview = entry.isError ? rows.slice(-3) : rows.slice(0, 2)
        lines.push(...preview.filter(Boolean).map(row => fit(`  ${color(row, entry.isError ? theme.error : theme.muted)}`)))
      }
    }
  }
  if (!expanded && (completed.length > 1 || completed.some(entry => (entry.content ?? '').split('\n').length > 2))) {
    lines.push(fit(color(`  ${shown.length < completed.length ? `… +${completed.length - shown.length} 个结果 · ` : ''}${input.expandHint ?? EXPAND_HINT} · 工具详情`, theme.muted)))
  }
  return lines
}

// ── Rendering: live region ─────────────────────────────────────

/**
 * 渲染 live 区域聚合行（进行中的探索工具）。
 * 区别于独立 tool card：所有 collapsible 工具聚合成一行，
 * 避免 live 区被 5+ 个 read/grep 卡片刷屏。
 */
export function formatCollapsedGroupLive(
  group: CollapsedReadSearchGroup,
  theme: RivetTheme,
  columns?: number,
): string[] {
  const lines: string[] = []
  const summary = buildSummaryText(group, true)
  const elapsed = Date.now() - group.startMs
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(0)}s` : `${elapsed}ms`
  const width = Math.max(2, (columns ?? 80) - 1)
  const widthOptions = { ambiguousAsWide: ambiguousWideEnabled() }
  const stats = computeGroupStats(group)
  const header = `● ${summary} · ${elapsedStr}`
  lines.push(color(displayWidth(header, widthOptions) <= width ? header : `● ${stats.pendingCount ? `运行中 ${stats.pendingCount}` : `完成 ${stats.completedCount}`} · ${elapsedStr}`, theme.muted))

  // 显示最近一条已完成 entry 的末 2 行作为进度预览
  const lastCompleted = [...group.entries].reverse().find(e => e.content && e.completed)
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

/**
 * CollapsedReadSearchBuffer — 管理折叠组的生命周期。
 *
 * 温跃层：buffer 管理从 app.ts 的事件处理器中分离出来，
 * 使 app.ts 只需调用 buffer API，无需管理内部状态。
 * buffer 可独立测试，不依赖 TuiApp 实例化。
 */
export class CollapsedReadSearchBuffer {
  private group: CollapsedReadSearchGroup | null = null

  /** 推入一个新的 collapsible tool use */
  pushUse(id: string, toolName: string, input: Record<string, unknown>): void {
    const kind = classifyCollapsibleKind(toolName)
    if (kind === null) return // 防御：不应被非 collapsible 调用

    if (!this.group) {
      this.group = { entries: [], startMs: Date.now() }
    }

    this.group.entries.push({
      id,
      toolName,
      input,
      displayName: entryDisplayName(toolName, input),
      kind,
      completed: false,
    })
  }

  /** 绑定 terminal result 到对应 entry（按 toolUseId） */
  attachResult(id: string, content: string, isError?: boolean, rawPath?: string): CollapsedReadSearchEntry | null {
    if (!this.group) return null
    return attachResult(this.group, id, content, isError, rawPath)
  }

  /** 新到达的 tool 是否应打断当前组 */
  shouldBreak(toolName: string): boolean {
    return shouldBreakGroup(toolName)
  }

  /** 取出当前组并清空 buffer（flush 到 scrollback） */
  flush(): CollapsedReadSearchGroup | null {
    const g = this.group
    this.group = null
    return g
  }

  /** 获取当前活跃组（不清空，用于 live 渲染和状态检查） */
  getActive(): CollapsedReadSearchGroup | null {
    return this.group
  }

  /** 当前组中是否还有未完成的 entry */
  hasPending(): boolean {
    return this.group?.entries.some(e => !e.completed) ?? false
  }

  /** 是否有活跃组 */
  isActive(): boolean {
    return this.group !== null
  }
}
