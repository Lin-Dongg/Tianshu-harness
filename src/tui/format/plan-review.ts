/**
 * Plan-review 钉底审阅区：左对齐身份与事实、可滚正文、明确编号决策。
 * 不渲染模型档 / cheap / 低阶产出——审批人只看文档和日期。
 *
 * 纯函数，无 I/O。高度由调用方按终端预算传入 bodyRows，避免把 live 高水位抬死。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { ambiguousWideEnabled, displayWidth, hardWrapToDisplayWidth } from '../width.js'
import { formatMarkdown } from './markdown.js'
import { CURSOR, frameBottom, frameDivider, frameHintRows, frameLine, frameTitleLeft } from './overlay-frame.js'
import type { PlanSubmittedInfo } from '../../tools/types.js'

export interface PlanReviewAction {
  id: string
  label: string
  kind: 'approve' | 'reject'
  recommended?: boolean
}

export interface PlanReviewInput {
  title: string
  /** 提交日期（YYYY-MM-DD）。缺席则不标。 */
  date?: string
  body: string
  scroll?: number
  width: number
  /** 正文窗口行数（不含边框/分隔线/决策行）。 */
  bodyRows?: number
  countdown?: string
  actions: PlanReviewAction[]
  feedbackMode?: boolean
  compact?: boolean
  /** 输入框分隔符风格——审批卡边框与输入框同族（thin/thick/dots/kimi）。 */
  separator?: string
}

/** 零基行号由渲染结构给出，主区可保护决策，不从计划正文识别动作。 */
export interface PlanReviewLayout {
  lines: string[]
  titleRow: number
  firstFactRow: number
  /** 与 actions 数组对齐；同行布局的多个动作共享行号。反馈模式仅一个状态行。 */
  actionRows: number[]
  recommendedActionRow: number | null
  countdownRows: number[]
  footerRow: number
  footerRows: number[]
}

const DEFAULT_BODY_ROWS = 6

/** 本地日历日，避免 UTC 把晚上提交拨到前一天。 */
export function formatPlanReviewDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 正文窗口：矮屏至少 4 行，高屏封顶 9，给边框/决策区/输入框留位。 */
export function planReviewBodyRows(termRows: number): number {
  return Math.max(4, Math.min(9, (termRows || 24) - 15))
}

export function clampPlanReviewScroll(scroll: number, total: number, window: number): number {
  const max = Math.max(0, total - Math.max(1, window))
  if (!Number.isFinite(scroll)) return 0
  return Math.min(max, Math.max(0, Math.trunc(scroll)))
}

export function buildPlanReviewActions(info: PlanSubmittedInfo): PlanReviewAction[] {
  const actions: PlanReviewAction[] = []
  const options = info.options ?? []
  if (options.length > 1) {
    for (const [i, o] of options.entries()) {
      const recommended = o.recommended === true || (o.recommended === undefined && /recommended/i.test(o.label))
      const cleanLabel = o.label.replace(/\s*[(（]?\s*recommended\s*[)）]?/i, '').trim()
      actions.push({
        id: `approve:${i}`,
        label: `批准 — ${cleanLabel}`,
        kind: 'approve',
        recommended,
      })
    }
  } else {
    actions.push({ id: 'approve', label: '批准并执行', kind: 'approve', recommended: true })
  }
  actions.push(
    { id: 'reject', label: '驳回修订', kind: 'reject' },
    { id: 'reject-exit', label: '驳回并退出', kind: 'reject' },
  )
  return actions
}

export function recommendedPlanReviewAction(actions: readonly PlanReviewAction[]): PlanReviewAction | undefined {
  return actions.find(a => a.recommended) ?? actions.find(a => a.kind === 'approve') ?? actions[0]
}

export function formatPlanReview(input: PlanReviewInput, theme: RivetTheme): string[] {
  return formatPlanReviewLayout(input, theme).lines
}

export function formatPlanReviewLayout(input: PlanReviewInput, theme: RivetTheme): PlanReviewLayout {
  const width = Math.max(8, input.width)
  const widthOptions = { ambiguousAsWide: ambiguousWideEnabled() }
  const bodyRows = Math.max(1, input.bodyRows ?? DEFAULT_BODY_ROWS)
  const actions = input.actions
  const inner = Math.max(1, width - 4)
  const rendered = input.body.trim().length > 0
    ? formatMarkdown({ text: input.body, columns: inner }, theme)
    : [color('（计划正文为空）', theme.muted)]
  const countdownText = input.countdown ? hardWrapToDisplayWidth(input.countdown, inner, widthOptions) : []
  const window = Math.max(1, bodyRows - countdownText.length)
  const hasOverflow = rendered.length > window
  const viewRows = hasOverflow ? Math.max(1, window - 1) : window
  const scroll = clampPlanReviewScroll(input.scroll ?? 0, rendered.length, viewRows)
  const slice = rendered.slice(scroll, scroll + viewRows)
  const remaining = Math.max(0, rendered.length - scroll - slice.length)

  const lines = [frameTitleLeft(`计划审批 · ${input.title}`, width, theme)]
  const facts = [input.date, `正文 ${Math.min(scroll + 1, rendered.length)}/${rendered.length}`].filter(Boolean).join(' · ')
  lines.push(frameLine(` ${color(facts, theme.muted)}`, width, theme))
  const countdownRows: number[] = []
  for (const row of countdownText) {
    countdownRows.push(lines.length)
    lines.push(frameLine(` ${color(row, theme.warning)}`, width, theme))
  }
  for (const row of slice) lines.push(frameLine(` ${row}`, width, theme))
  if (remaining > 0) lines.push(frameLine(` ${color(`…(+${remaining})`, theme.dim)}`, width, theme))
  lines.push(frameDivider(width, theme))

  if (input.feedbackMode) {
    const actionRows = [lines.length]
    lines.push(frameLine(` ${color('反馈输入中', theme.secondary, { bold: true })}`, width, theme))
    const footerRow = lines.length
    const footer = frameHintRows([['Enter', '提交反馈'], ['Esc', '返回审批']], width, theme)
    const footerRows = footer.map((_, i) => footerRow + i)
    lines.push(...footer)
    lines.push(frameBottom(width, theme))
    return { lines, titleRow: 0, firstFactRow: 1, actionRows, recommendedActionRow: null, countdownRows, footerRow, footerRows }
  }

  const recommended = recommendedPlanReviewAction(actions)
  const actionPieces = actions.map((a, i) => {
    const mark = a.kind === 'approve' ? '✓' : '✗'
    const markColor = a.kind === 'approve' ? theme.success : theme.muted
    const labelColor = a.kind === 'approve' ? theme.success : theme.secondary
    const body = `${mark} ${i + 1} ${a.label}`
    if (a === recommended) {
      return color(`${CURSOR} `, theme.primary, { bold: true }) + color(body, theme.success, { bold: true })
    }
    return `  ${color(mark, markColor)} ${color(`${i + 1} ${a.label}`, labelColor)}`
  })
  const actionPlain = actions.map((a, i) => `${a.kind === 'approve' ? '✓' : '✗'} ${i + 1} ${a.label}`).join('    ')
  const recPrefix = recommended ? 2 : 0
  const actionRows: number[] = []
  let recommendedActionRow: number | null = null
  if (input.compact) {
    if (recommended) {
      recommendedActionRow = lines.length
      lines.push(frameLine(` ${actionPieces[actions.indexOf(recommended)]}`, width, theme))
    }
    const summary = actions.map((a, i) => `${i + 1} ${a.kind === 'approve' ? '批准' : a.id === 'reject-exit' ? '退出' : '修订'}`).join(' · ')
    const rows = hardWrapToDisplayWidth(summary, inner - 1, widthOptions)
    for (const row of rows) lines.push(frameLine(` ${color(row, theme.muted)}`, width, theme))
    actionRows.push(...actions.map(() => lines.length - rows.length))
  } else if (displayWidth(actionPlain, widthOptions) + recPrefix <= inner - 1) {
    actionRows.push(...actions.map(() => lines.length))
    lines.push(frameLine(` ${actionPieces.join('    ')}`, width, theme))
  } else {
    for (const piece of actionPieces) {
      actionRows.push(lines.length)
      lines.push(frameLine(` ${piece}`, width, theme))
    }
  }
  recommendedActionRow ??= recommended ? actionRows[actions.indexOf(recommended)] ?? null : null
  const footerRow = lines.length
  const footer = frameHintRows(input.compact ? [['Enter', '推荐'], ['v', '全文'], ['f', '反馈'], ['Esc', '收起']] : [['数字', '选择方案'], ['Enter', '推荐方案'], ['f', '反馈'], ['↑↓/PgUp/PgDn', '滚动'], ['v', '全文'], ['Esc', '收起']], width, theme)
  const footerRows = footer.map((_, i) => footerRow + i)
  lines.push(...footer)
  lines.push(frameBottom(width, theme))
  return { lines, titleRow: 0, firstFactRow: 1, actionRows, recommendedActionRow, countdownRows, footerRow, footerRows }
}
