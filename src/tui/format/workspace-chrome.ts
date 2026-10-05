import { stripVTControlCharacters } from 'node:util'
import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth, ambiguousWideEnabled } from '../width.js'
import type { CacheStatus } from '../status-types.js'
import type { RivetTheme } from '../theme.js'

const policy = () => ({ ambiguousAsWide: ambiguousWideEnabled() })
function fit(text: string, width: number): string {
  if (displayWidth(text, policy()) <= width) return text
  return truncateToDisplayWidth(text, Math.max(0, width - displayWidth('…', policy())), policy()) + '…'
}

export function formatWorkspacePath(cwd: string, columns: number, theme: RivetTheme): string {
  const label = '工作区：', width = Math.max(1, columns - 1)
  const path = stripVTControlCharacters(cwd).replace(/[\r\n\t]/g, ' ')
  const available = width - displayWidth(label, policy())
  if (displayWidth(path, policy()) <= available) return color(label + path, theme.muted)
  if (available < 4) return color(fit(label + path, width), theme.muted)
  const head = truncateToDisplayWidth(path, Math.floor(available / 3), policy())
  const tailWidth = available - displayWidth(head + '…', policy())
  let tail = ''
  const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(path))
  for (const part of parts.reverse()) {
    if (displayWidth(part.segment + tail, policy()) > tailWidth) break
    tail = part.segment + tail
  }
  return color(label + head + '…' + tail, theme.muted)
}

/**
 * Bounded telemetry; absent measurements stay unknown, including zero-priced sessions.
 * 常驻输入区不再使用——保留为 `/metrics` 详情入口的行源（历史形态的工作区详情块）。
 */
export function formatWorkspaceTelemetry(input: {
  width: number; branch?: string; effort?: string; cacheHitRate?: number | null; cacheStatus?: CacheStatus
  estimatedTokens?: number; maxTokens?: number; cost?: number; costSource?: 'api' | 'estimate' | 'unknown'
  jobs: number; workers: number
}, theme: RivetTheme): string[] {
  const width = Math.max(1, input.width - 1), narrow = width < 79
  const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0
  const cache = known(input.cacheHitRate) ? `${Math.round(input.cacheHitRate * 100)}%` : '—'
  const health = input.cacheStatus === 'degraded' ? '冷' : input.cacheStatus === 'stale' ? '旧'
    : input.cacheStatus === 'recovering' ? '恢复' : ''
  const context = known(input.estimatedTokens) && known(input.maxTokens) && input.maxTokens > 0
    ? `${Math.round(input.estimatedTokens / input.maxTokens * 100)}%` : '—'
  const source = input.costSource === 'api' ? 'API' : input.costSource === 'estimate' ? '估' : ''
  const cost = source && known(input.cost) ? `${source}¥${input.cost.toFixed(2)}` : '费用—'
  const primary = `${narrow ? '缓' : '缓存'}${cache}${health}  ${narrow ? '上' : '上下文'}${context}  ${cost}`
  const safe = (value: string) => stripVTControlCharacters(value).replace(/[\r\n\t]/g, ' ')
  const detail = `分支 ${safe(input.branch ?? '—')}  推理 ${safe(input.effort ?? '—')}  后台 ${input.jobs}  worker ${input.workers} · /tasks`
  const tint = health ? theme.warning : theme.muted
  if (narrow) return [color(`${fit(primary, Math.max(0, width - 11))} · /metrics`, tint)]
  return [color(fit(primary, width), tint), color(`${fit(detail, Math.max(0, width - 11))} · /metrics`, theme.muted)]
}
