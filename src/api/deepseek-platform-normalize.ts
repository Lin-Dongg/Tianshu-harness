import type { DeepSeekUserSummary, DeepSeekCostReport, DeepSeekCostEntry } from './deepseek-platform-client.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
function number(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Expected number')
  if (typeof value === 'string' && !value.trim()) throw new Error('Empty number')
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid number')
  return parsed
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array')
  return value
}

/** Current platform storage and response shapes checked against its public JS (2026-10-03). */
export function normalizeWalletSummary(value: unknown): DeepSeekUserSummary {
  const raw = object(value)
  const normal = array(raw.normal_wallets).map(object)
  const bonus = array(raw.bonus_wallets).map(object)
  const currencies = [...new Set([...normal, ...bonus].map(wallet => wallet.currency))]
  const currency = currencies.includes('CNY') ? 'CNY' : currencies[0]
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Missing wallet currency')
  const sum = (wallets: Record<string, unknown>[]) => wallets.filter(wallet => wallet.currency === currency).reduce((total, wallet) => total + number(wallet.balance), 0)
  const topped = sum(normal), granted = sum(bonus)
  return {
    is_account_available: true,
    estimated_available_tokens: raw.total_available_token_estimation == null ? undefined : number(raw.total_available_token_estimation),
    balance_info: { currency, total_balance: topped + granted, topped_up_balance: topped, granted_balance: granted },
  }
}

export function platformMonthRange(month: number, year: number) {
  const offset = -new Date(year, month - 1, 1).getTimezoneOffset() * 60
  return {
    start: Date.UTC(year, month - 1, 1) / 1000 - offset,
    end: Date.UTC(year, month, 1) / 1000 - offset - 1,
    tz: offset,
  }
}

/** Current platform amounts are currency units; the existing desktop contract uses cents. */
export function normalizeKeyUsage(amountValue: unknown, costValue: unknown, timezoneSeconds: number): DeepSeekCostReport {
  const amount = object(amountValue), costs = object(costValue)
  const models = new Map<string, Map<string, DeepSeekCostEntry>>()
  const getEntry = (series: Record<string, unknown>, bucket: Record<string, unknown>) => {
    if (typeof series.model !== 'string') throw new Error('Missing model')
    const timestamp = number(bucket.time)
    const date = new Date((timestamp + timezoneSeconds) * 1000).toISOString().slice(0, 10)
    let days = models.get(series.model)
    if (!days) { days = new Map(); models.set(series.model, days) }
    let entry = days.get(date)
    if (!entry) {
      entry = { date, total_tokens: 0, cost_in_cents: 0, input_cache_hit_tokens: 0, input_cache_miss_tokens: 0, output_tokens: 0, request_count: 0 }
      days.set(date, entry)
    }
    return entry
  }
  for (const item of array(amount.series)) {
    const series = object(item)
    for (const item of array(series.buckets)) {
      const bucket = object(item), usage = object(bucket.usage), entry = getEntry(series, bucket)
      const hit = number(usage.PROMPT_CACHE_HIT_TOKEN), miss = number(usage.PROMPT_CACHE_MISS_TOKEN), output = number(usage.RESPONSE_TOKEN)
      entry.input_cache_hit_tokens += hit
      entry.input_cache_miss_tokens += miss
      entry.output_tokens += output
      entry.request_count += number(usage.REQUEST)
      entry.total_tokens += hit + miss + output
    }
  }
  for (const item of array(costs.data)) {
    const group = object(item)
    if (group.currency !== 'CNY') throw new Error('Cost panel currently requires CNY')
    for (const item of array(group.series)) {
      const series = object(item)
      for (const item of array(series.buckets)) {
        const bucket = object(item)
        getEntry(series, bucket).cost_in_cents += number(bucket.cost) * 100
      }
    }
  }
  const result = [...models].map(([model, days]) => ({ model, usage: [...days.values()].sort((a, b) => a.date!.localeCompare(b.date!)) }))
  const entries = result.flatMap(model => model.usage)
  return {
    models: result,
    total: { cost_in_cents: entries.reduce((total, entry) => total + entry.cost_in_cents, 0), total_tokens: entries.reduce((total, entry) => total + entry.total_tokens, 0) },
  }
}
