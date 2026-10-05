/**
 * DeepSeek 官方账单快照 — 缓存面板「官方区」的数据源与降级链。
 *
 * 降级链（TUI 不做网页登录，只消费桌面端持久化的共享凭证）：
 *   1. `~/.rivet/deepseek-platform-auth.json` 在 → 平台 summary（今日/本月花费 + 余额）
 *   2. 平台不可用但有 DeepSeek API key → `/user/balance` 余额
 *   3. 都没有 → 引导去桌面端登录
 */
import { getDeepSeekUserSummary, loadPlatformAuth, type PlatformFailure } from '../api/deepseek-platform-client.js'
import { queryDeepSeekBalance } from '../api/balance-client.js'

export interface OfficialUsageSnapshot {
  source: 'platform' | 'balance' | 'none'
  /** 元（平台返回的 cost_in_cents 已在此处 /100） */
  todayCost?: number
  monthCost?: number
  balance?: string
  currency?: string
  requests?: number
  /** source==='none' 时的引导文案；降级到 balance 时说明平台为何不可用 */
  hint?: string
  failure?: PlatformFailure
}

export interface OfficialUsageDeps {
  apiKey: string | undefined
  baseUrl: string | undefined
  signal?: AbortSignal
}

function failureHint(failure: PlatformFailure | undefined): string {
  switch (failure) {
    case 'unauthorized': return '平台登录已过期，去桌面端「成本」重新登录'
    case 'network': return '平台账单请求失败（网络错误），稍后重试'
    case 'malformed': return '平台返回结构异常，暂无法展示账单'
    default: return '未登录 DeepSeek 平台，去桌面端「成本」登录后可看官方账单'
  }
}

/** 拉一次官方快照。永不抛错——面板拿到的总是可渲染的结果。 */
export async function fetchOfficialUsage(deps: OfficialUsageDeps): Promise<OfficialUsageSnapshot> {
  const hasPlatformAuth = loadPlatformAuth() !== null

  if (hasPlatformAuth) {
    const result = await getDeepSeekUserSummary(deps.apiKey, deps.baseUrl, deps.signal)
    if (result.data) {
      const s = result.data
      return {
        source: 'platform',
        todayCost: s.current_day_cost === undefined ? undefined : s.current_day_cost / 100,
        monthCost: s.current_month_cost === undefined ? undefined : s.current_month_cost / 100,
        balance: String(s.balance_info?.total_balance ?? ''),
        currency: s.balance_info?.currency ?? 'CNY',
        requests: s.current_day_requests,
      }
    }
    // 平台可达性失败 → 退到 API key 余额，但把原因带上，别让用户以为没登录
    const balance = await queryDeepSeekBalance(deps.apiKey, deps.baseUrl, deps.signal)
    const first = balance?.balances[0]
    if (first) {
      return {
        source: 'balance',
        balance: first.totalBalance,
        currency: first.currency,
        failure: result.failure,
        hint: failureHint(result.failure),
      }
    }
    return { source: 'none', failure: result.failure, hint: failureHint(result.failure) }
  }

  const balance = await queryDeepSeekBalance(deps.apiKey, deps.baseUrl, deps.signal)
  const first = balance?.balances[0]
  if (first) {
    return { source: 'balance', balance: first.totalBalance, currency: first.currency }
  }
  return { source: 'none', failure: 'no-credentials', hint: failureHint(undefined) }
}
