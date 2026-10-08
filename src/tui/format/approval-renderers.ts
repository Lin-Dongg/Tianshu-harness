/**
 * T9 工具专用审批渲染器。
 *
 * 为不同工具提供差异化的审批前预览：
 * - bash：展示完整命令 + 危险命令检测
 * - write_file：展示路径、行数、内容预览
 * - edit_file / hash_edit：展示 diff 预览
 * - delegate_task / delegate_batch：展示目标/任务数
 * - 其他：回退到通用 JSON 摘要
 */

import { stripVTControlCharacters } from 'node:util'
import { dirname, resolve } from 'node:path'
import { color } from '../engine/ansi.js'
import { renderCodeDiff } from './code-diff.js'
import type { RivetTheme } from '../theme.js'
import { ambiguousWideEnabled, displayWidth, truncateToDisplayWidth } from '../width.js'
import { useAsciiBorders } from '../term-caps.js'
import type { RiskExplanation, RiskLevel } from '../../agent/risk-explain.js'
import { readClaimConflict, type ClaimConflictInfo } from '../../agent/claim-liveness.js'

export interface ApprovalRenderer {
  /** 渲染审批预览行（每行已做列宽控制，调用方直接显示） */
  render(toolName: string, input: Record<string, unknown>, columns: number, theme: RivetTheme, options?: ApprovalPreviewOptions): string[]
}

export interface ApprovalPreviewOptions {
  /** 标签含分隔符，在布局前计算其真实字宽；默认保留英文 API。 */
  labels?: Readonly<Record<string, string>>
  /** 外层已有全文提示时，生成的范围行只说明显示范围。 */
  showFullHint?: boolean
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  />\s*\/dev\/(sda|disk|hd)/,
  /:\(\)\s*\{\s*:\s*\|:\s*\}\s*;\s*:/,
  /curl\s+[^|]+\|\s*(sh|bash|zsh)/,
  /wget\s+[^|]+\|\s*(sh|bash|zsh)/,
  /mkfs\./,
  /dd\s+if=/,
]

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd))
}

const WIDE = { get ambiguousAsWide(): boolean { return ambiguousWideEnabled() } }
const PREVIEW_ROWS = 6

/**
 * 渲染/序列化审批入参时剥掉 `__` 前缀的内部标记键（如 __claimConflict）——
 * 它们是给渲染层的结构化信号，不是用户可读参数；标记本身由渲染层特判成文案。
 */
function publicInputEntries(input: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(input).filter(([key]) => !key.startsWith('__'))
}

/** 认领冲突横幅（事实区首行，短屏截断也优先保住它）。 */
function claimConflictLines(conflict: ClaimConflictInfo, columns: number, theme: RivetTheme): string[] {
  const owner = conflict.ownerSessionId.slice(0, 8)
  const lines = wrapFact(`⚠ 认领冲突：${conflict.filePath} 正被另一个会话（${owner}）持有`, columns)
    .map(line => color(line, theme.warning))
  if (conflict.reason) lines.push(...wrapFact(conflict.reason, columns).map(line => color(line, theme.muted)))
  lines.push(...wrapFact('批准 = 接管该文件并继续本次操作；拒绝 = 保持对方持有', columns).map(line => color(line, theme.muted)))
  return lines
}

/** Wrap facts without losing command/path suffixes; columns includes caller padding. */
function wrapFact(value: string, columns: number): string[] {
  const width = Math.max(2, columns - 2)
  return value.split('\n').flatMap(line => {
    const rows: string[] = []
    let rest = line
    while (displayWidth(rest, WIDE) > width) {
      const row = truncateToDisplayWidth(rest, width, WIDE)
      rows.push(row)
      rest = rest.slice(row.length)
    }
    rows.push(rest)
    return rows
  })
}

function factPreview(rows: string[], columns: number, theme: RivetTheme, options?: ApprovalPreviewOptions, limit = PREVIEW_ROWS): string[] {
  const shown = rows.slice(0, limit)
  const fullHint = options?.showFullHint === false ? '' : ' · v 全文'
  const range = rows.length > limit
    ? `显示 1-${limit} / 共 ${rows.length} 行${fullHint}`
    : `当前显示全部 ${rows.length} 行${fullHint}`
  return [...shown, ...(options?.labels && limit < PREVIEW_ROWS ? [''] : []), ...wrapFact(range, columns).map(line => color(line, theme.dim))]
}

function labeledFacts(label: string, value: string, columns: number, theme: RivetTheme, options?: ApprovalPreviewOptions): string[] {
  const prefix = options?.labels?.[label] ?? `${label}: `, indent = displayWidth(prefix, WIDE)
  if (indent >= columns - 4) return [color(prefix.trimEnd(), theme.muted), ...wrapFact(value, columns).map(line => color(line, theme.muted))]
  return wrapFact(value, columns - indent).map((line, i) => color(`${i ? ' '.repeat(indent) : prefix}${line}`, theme.muted))
}

function labeledPreview(label: string, value: string, columns: number, theme: RivetTheme, options?: ApprovalPreviewOptions): string[] {
  const rows = labeledFacts(label, value, columns, theme, options)
  return rows.length > PREVIEW_ROWS ? factPreview(rows, columns, theme, options) : rows
}

const bashRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input)
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined
    const lines: string[] = []
    if (cwd) {
      lines.push(...labeledPreview('CWD', cwd, columns, theme, options))
    }
    if (options?.labels && cwd) lines.push('')
    if (options?.labels?.Command && columns < 60) {
      lines.push(color(options.labels.Command.trimEnd(), theme.muted))
      lines.push(...factPreview(wrapFact(cmd, columns).map(line => color(line, theme.muted)), columns, theme, options, 3))
    } else lines.push(...factPreview(labeledFacts('Command', cmd, columns, theme, options), columns, theme, options))
    if (isDangerousCommand(cmd)) {
      lines.push(...wrapFact('! 本地规则提示：High-risk command detected', columns).map(line => color(line, theme.warning)))
    }
    return lines
  },
}

const fileWriteRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null
    const content = typeof input.content === 'string' ? input.content : null
    const lines: string[] = []
    if (filePath) {
      lines.push(...labeledPreview('Path', filePath, columns, theme, options))
    }
    if (content !== null) {
      const contentLines = content.split('\n')
      lines.push(...labeledFacts('Mode', input.mode === 'append' ? 'append 原样追加' : 'overwrite 整文件覆盖（新路径则新建）', columns, theme, options))
      lines.push(...wrapFact(`${contentLines.length} lines`, columns).map(line => color(line, theme.muted)))
      const contentRows = contentLines.flatMap((line, i) => wrapFact(`${i + 1} │ ${line}`, columns).map(row => color(row, theme.muted)))
      lines.push(...factPreview(contentRows, columns, theme, options))
      const extra = Object.fromEntries(publicInputEntries(input).filter(([key]) => !['file_path', 'path', 'content', 'mode'].includes(key)))
      if (Object.keys(extra).length) lines.push(...factPreview(labeledFacts('Parameters', JSON.stringify(extra), columns, theme, options), columns, theme, options))
    }
    return lines
  },
}

const fileReadRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const paths = typeof input.file_path === 'string' ? [input.file_path]
      : Array.isArray(input.file_paths) ? input.file_paths.filter((path): path is string => typeof path === 'string') : []
    return paths.length ? paths.flatMap(path => labeledPreview('Path', path, columns, theme, options))
      : labeledPreview('Parameters', JSON.stringify(input), columns, theme, options)
  },
}

const fileEditRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null
    const oldStr = typeof input.old_string === 'string' ? input.old_string : null
    const newStr = typeof input.new_string === 'string' ? input.new_string : null
    const lines: string[] = []
    if (filePath) lines.push(...labeledPreview('Path', filePath, columns, theme, options))
    if (oldStr !== null && newStr !== null) {
      const oldLines = oldStr.split('\n').length
      const newLines = newStr.split('\n').length
      lines.push(...wrapFact(`替换片段：${oldLines} → ${newLines} 行`, columns).map(line => color(line, theme.muted)))
      const startLine = typeof input.start_line === 'number' ? input.start_line : 1
      const diff = renderCodeDiff(oldStr, newStr, Math.max(1, columns - 2), theme, theme.background === 'light', startLine)
      if (typeof input.start_line !== 'number') lines.push(...wrapFact('行号相对于替换片段', columns).map(line => color(line, theme.dim)))
      if (diff.length <= PREVIEW_ROWS) lines.push(...factPreview(diff, columns, theme, options))
      else {
        const firstChange = diff.findIndex(row => /^\s*\d+ [-+]/.test(stripVTControlCharacters(row)))
        const start = Math.max(0, firstChange - 1)
        const firstAdded = diff.findIndex(row => /^\s*\d+ \+/.test(stripVTControlCharacters(row)))
        const split = firstAdded > start + PREVIEW_ROWS / 2 ? firstAdded : start + PREVIEW_ROWS / 2
        const shown = [...diff.slice(start, start + PREVIEW_ROWS / 2), ...diff.slice(split, split + PREVIEW_ROWS / 2)]
        lines.push(...shown, ...wrapFact(`显示变更 ${shown.length} / 共 ${diff.length} 行${options?.showFullHint === false ? '' : ' · v 全文'}`, columns).map(line => color(line, theme.dim)))
      }
    } else {
      lines.push(...factPreview(labeledFacts('Parameters', JSON.stringify(input), columns, theme, options), columns, theme, options))
    }
    return lines
  },
}

const delegateRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const lines: string[] = []
    if (toolName === 'delegate_batch') {
      const tasks = Array.isArray(input.tasks) ? input.tasks : []
      const profile = typeof input.profile === 'string' ? input.profile : 'default'
      lines.push(...wrapFact(`Delegate ${tasks.length} tasks (profile: ${profile})`, columns).map(line => color(line, theme.warning)))
      for (let i = 0; i < Math.min(3, tasks.length); i++) {
        const t = tasks[i] as Record<string, unknown> | undefined
        const obj = t && typeof t.objective === 'string' ? t.objective : JSON.stringify(t)
        lines.push(...labeledPreview(`  ${i + 1}`, obj, columns, theme, options))
      }
      if (tasks.length > 3) {
        lines.push(...wrapFact(`… +${tasks.length - 3} more tasks${options?.showFullHint === false ? '' : ' · v 全文'}`, columns).map(line => color(line, theme.muted)))
      }
      return lines
    }
    const objective = typeof input.objective === 'string' ? input.objective : JSON.stringify(input)
    const profile = typeof input.profile === 'string' ? input.profile : undefined
    lines.push(...labeledPreview('Objective', objective, columns, theme, options))
    if (profile) {
      lines.push(...labeledPreview('Profile', profile, columns, theme, options))
    }
    return lines
  },
}

const webRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const value = typeof input.url === 'string'
      ? input.url
      : typeof input.query === 'string'
        ? input.query
        : JSON.stringify(input)
    const label = toolName === 'web_fetch' || typeof input.url === 'string' ? 'URL' : 'Query'
    return labeledPreview(label, value, columns, theme, options)
  },
}

const fallbackRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme, options) {
    const raw = JSON.stringify(Object.fromEntries(publicInputEntries(input)))
    const rows = wrapFact(`→ ${raw}`, columns).map(line => color(line, theme.muted))
    return rows.length > PREVIEW_ROWS ? factPreview(rows, columns, theme, options) : rows
  },
}

const RENDERERS: Record<string, ApprovalRenderer> = {
  bash: bashRenderer,
  shell: bashRenderer,
  sandbox_exec: bashRenderer,
  read_file: fileReadRenderer,
  write_file: fileWriteRenderer,
  write: fileWriteRenderer,
  edit_file: fileEditRenderer,
  edit: fileEditRenderer,
  hash_edit: fileEditRenderer,
  delegate_task: delegateRenderer,
  delegate_batch: delegateRenderer,
  web_fetch: webRenderer,
  web_search: webRenderer,
}

/**
 * 获取指定工具的审批渲染器。
 */
export function getApprovalRenderer(toolName: string): ApprovalRenderer {
  return RENDERERS[toolName] ?? fallbackRenderer
}

/**
 * 渲染审批预览行。
 */
export function renderApprovalPreview(
  toolName: string,
  input: Record<string, unknown>,
  columns: number,
  theme: RivetTheme,
  options?: ApprovalPreviewOptions,
): string[] {
  const renderer = getApprovalRenderer(toolName)
  return renderer.render(toolName, input, columns, theme, options)
}

/** Read-only facts for the approval pager. The execution input is never changed. */
export function formatApprovalFacts(toolName: string, input: Record<string, unknown>, columns: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  // 认领冲突标记先翻译成人读横幅——「全文」是只读事实视图，不是 raw JSON dump。
  const conflict = readClaimConflict(input)
  if (conflict) lines.push(...claimConflictLines(conflict, columns, theme))
  if (['bash', 'shell', 'sandbox_exec'].includes(toolName)) {
    if (typeof input.command === 'string') lines.push(...labeledFacts('Command', input.command, columns, theme))
    if (typeof input.cwd === 'string') lines.push(...labeledFacts('CWD', input.cwd, columns, theme))
  }
  const filePath = input.file_path ?? input.path
  if (typeof filePath === 'string') lines.push(...labeledFacts('Path', filePath, columns, theme))
  if (Array.isArray(input.file_paths)) {
    for (const path of input.file_paths) if (typeof path === 'string') lines.push(...labeledFacts('Path', path, columns, theme))
  }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const start = typeof input.start_line === 'number' ? input.start_line : 1
    if (typeof input.start_line !== 'number') lines.push(...labeledFacts('行号', '相对于替换片段', columns, theme))
    for (const [sign, value] of [['-', input.old_string], ['+', input.new_string]] as const) {
      lines.push(...value.split('\n').flatMap((line, i) => wrapFact(`${sign} ${start + i} │ ${line}`, columns).map(row => color(row, sign === '-' ? theme.error : theme.success))))
    }
  }
  if (typeof input.content === 'string') lines.push(...input.content.split('\n').flatMap((line, i) => labeledFacts(String(i + 1), line, columns, theme)))
  lines.push(...labeledFacts('Parameters', JSON.stringify(Object.fromEntries(publicInputEntries(input)), null, 2), columns, theme))
  return lines
}

export interface FormatApprovalPromptInput {
  toolName: string
  input: Record<string, unknown>
  columns: number
  /** 光标选项列表的选中行（0 批准 / 1 拒绝 / 2 编辑 JSON / 3 解释风险）。 */
  selectedIndex: number
  /** Ctrl+E 拉取的风险解释状态（未请求时三者皆空）。 */
  risk?: RiskExplanation | null
  riskPending?: boolean
  riskError?: string
  /** 工作区外路径审批：选项表插入「批准并记住此目录」（记住 = 授权持久化到本工作区）。 */
  rememberOption?: boolean
  /** 内核确认的新工作区外路径授权；路径为绝对路径，授权实际作用于各父目录及子路径。 */
  pathGrant?: { mode: 'read' | 'write'; paths: string[] }
  /** 当前审批区可用行数；短屏优先保留所有选择和授权范围。 */
  rows?: number
  /** 外层已绘制审批 footer 时关闭此处提示。 */
  showFooter?: boolean
}

export interface ApprovalPromptLayout {
  lines: string[]
  titleRow: number
  firstFactRow: number
  choiceRows: number[]
  footerRow: number | null
}

const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' }

function riskColor(level: RiskLevel, theme: RivetTheme): string {
  return level === 'high' ? theme.error : level === 'medium' ? theme.warning : theme.success
}

/**
 * 渲染 approval 行内提示。
 *
 * 对象与事实在分隔线上方；选择及授权范围在下方。
 * 保留 y/n/e/^E 直达键，只读全文入口不触发决定。
 */
export function formatApprovalPrompt(input: FormatApprovalPromptInput, theme: RivetTheme): string[] {
  return formatApprovalPromptLayout(input, theme).lines
}

/** 行定位由同一次排版产生，供固定输入/短屏视口保留真实选择。 */
export function formatApprovalPromptLayout(input: FormatApprovalPromptInput, theme: RivetTheme): ApprovalPromptLayout {
  const width = Math.max(2, input.columns - 1)
  const fit = (line: string): string[] => displayWidth(line, WIDE) <= width ? [line]
    : wrapFact(stripVTControlCharacters(line), width + 2).map(row => color(row, theme.muted))
  const title = fit(color(`等待审批 · ${input.toolName}`, theme.warning, { bold: true }))
  // 认领冲突（另一个会话持有目标文件）：横幅进事实区首行，批准项改写为接管语义——
  // 普通「批准/拒绝」措辞会把「是否接管」读成「是否允许写入」，授权对象错位。
  const conflict = readClaimConflict(input.input)
  const preview = [
    ...(conflict ? claimConflictLines(conflict, width - 2, theme) : []),
    ...renderApprovalPreview(input.toolName, input.input, width - 2, theme, {
      labels: { CWD: '工作目录  ', Command: '命令  ', Path: '文件  ', Mode: '写入方式  ', Objective: '目标  ', Parameters: '参数  ' },
      showFullHint: false,
    }),
  ]
    .map(line => `  ${line}`)
  const risks: string[] = []
  if (input.riskPending) {
    risks.push(...fit(color('  正在分析这条操作的风险…', theme.muted)))
  } else if (input.riskError) {
    risks.push(...fit(color(`  风险分析不可用：${input.riskError}`, theme.warning)))
  } else if (input.risk) {
    const c = riskColor(input.risk.level, theme)
    risks.push(...fit(color(`  [${RISK_LABEL[input.risk.level]}]`, c, { bold: true })))
    for (const line of input.risk.lines) risks.push(...fit(`  ${color(line, theme.muted)}`))
  }
  const directories = [...new Set(input.pathGrant?.paths.map(path => dirname(resolve(path))) ?? [])]
  const capability = input.pathGrant?.mode === 'write' ? '读写' : '只读'
  const options = [conflict ? '接管并批准 (Enter/y)' : '批准 (Enter/y)', '拒绝 (Esc/n)', '编辑 JSON (e)']
  if (input.rememberOption) options.push(`批准并记住${directories.length > 1 ? ` ${directories.length} 个目录` : '此目录'} (r)`)
  if (!input.risk && !input.riskPending) options.push('解释风险 (^E)')
  const choices: string[][] = []
  options.forEach((label, i) => {
    if (directories.length && (i === 0 || (input.rememberOption && i === 3))) label += ` ${capability}`
    const cursor = i === input.selectedIndex
    const glyph = cursor ? color('>', theme.primary, { bold: true }) : ' '
    const text = cursor
      ? color(`${i + 1}. ${label}`, theme.primary, { bold: true })
      : color(`${i + 1}. ${label}`, theme.muted)
    const rows = fit(`  ${glyph} ${text}`)
    if (directories.length && (i === 0 || (input.rememberOption && i === 3))) {
      for (const directory of directories) rows.push(...fit(color(`     ${i === 0 ? '当前会话目录树' : '本工作区持久目录树'}：${directory}`, theme.muted)))
    } else if (input.rememberOption && i === 3) rows.push(...fit(color('     持久授权到本工作区', theme.muted)))
    choices.push(rows)
  })
  const footer = input.showFooter === false ? [] : fit(color('Enter 确认 · v 全文（只读）', theme.muted))
  const ruleGlyph = useAsciiBorders() ? '-' : '─'
  const rule = color(ruleGlyph.repeat(Math.floor(width / displayWidth(ruleGlyph, WIDE))), theme.dim)
  const reserved = title.length + choices.flat().length + footer.length + 1
  const budget = input.rows === undefined ? Number.POSITIVE_INFINITY : Math.max(0, input.rows - reserved)
  const roomy = budget >= preview.length + risks.length + 3
  const lines = [...title, ...(roomy ? [''] : [])]
  const firstFactRow = lines.length
  const factBudget = Math.max(1, budget - (roomy ? 3 : 0))
  if (preview.length + risks.length <= factBudget) lines.push(...preview, ...risks)
  else if (factBudget > 0) {
    const commandAt = preview.findIndex(line => stripVTControlCharacters(line) === '  命令')
    if (commandAt >= 0) {
      lines.push(fit(color(`  命令  ${stripVTControlCharacters(preview[commandAt + 1] ?? '').trimStart()}`, theme.muted))[0]!)
      if (factBudget > 1) lines.push(...preview.slice(0, Math.min(commandAt, factBudget - 2)), color('  其余事实已收起', theme.muted))
    }
    else if (factBudget === 1) lines.push(preview.find(line => /^  (?:命令  |文件  |目标  |URL:|Query:)/.test(stripVTControlCharacters(line))) ?? preview[0] ?? color('  参数  {}', theme.muted))
    else lines.push(...preview.slice(0, factBudget - 1), color('  其余事实已收起', theme.muted))
  }
  lines.push(rule)
  if (roomy) lines.push(color(conflict ? '  是否接管该文件？' : '  是否允许这次操作？', theme.secondary, { bold: true }))
  const choiceRows: number[] = []
  choices.forEach(rows => { choiceRows.push(lines.length); lines.push(...rows) })
  if (roomy) lines.push('')
  const footerRow = footer.length ? lines.length : null
  lines.push(...footer)
  return { lines, titleRow: 0, firstFactRow, choiceRows, footerRow }
}
