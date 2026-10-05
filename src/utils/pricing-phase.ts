import { isChinaPublicHoliday } from './china-holidays.js'

/**
 * DeepSeek 峰时/闲时计价时段判定（纯函数，主机时区无关）。
 *
 * 规则（2026-10-03 官方 pricing 文档）：北京时间（UTC+8）周一至周五
 * 9:00–12:00、14:00–18:00 为峰时正价，其余（含周末及中国法定节假日全天）为闲时半价。
 *
 * 实现只用 Date 的 UTC 字段 + 8h 固定偏移推北京时间，不碰宿主本地时区，
 * 任何 TZ 下确定性一致。提醒与本地逐请求费用估算共用此判据。
 */

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** 北京时间固定偏移（UTC+8，无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * HOUR_MS

/** 北京时间每日峰时窗口（分钟-of-day，左闭右开）。改官方规则 = 改这张表。 */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 窗口全部边界 = 可能的相位切换点（周末边界两侧同为闲时，自动跳过）。 */
const TRANSITION_MINUTES = PEAK_WINDOWS.flatMap(([start, end]) => [start, end])

export type PricingPhase = 'peak' | 'offpeak'

/** 北京时间的星期/分钟-of-day/当日 0 点对应的 epoch ms。 */
function beijingParts(nowMs: number): { weekday: number; minuteOfDay: number; dayStartMs: number } {
  const shifted = nowMs + BEIJING_OFFSET_MS
  const d = new Date(shifted)
  return {
    weekday: d.getUTCDay(),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dayStartMs: Math.floor(shifted / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS,
  }
}

/** 当前计价相位：'peak' = 峰时正价，'offpeak' = 闲时半价。 */
export function deepseekPricingPhase(nowMs: number): PricingPhase {
  const { weekday, minuteOfDay } = beijingParts(nowMs)
  // 周末全天闲时
  if (weekday === 0 || weekday === 6 || isChinaPublicHoliday(new Date(nowMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10))) return 'offpeak'
  return PEAK_WINDOWS.some(([start, end]) => minuteOfDay >= start && minuteOfDay < end)
    ? 'peak'
    : 'offpeak'
}

/** 距下次相位切换的毫秒数与切换后相位（倒计时文案用）。 */
export function nextPricingTransition(nowMs: number): { to: PricingPhase; inMs: number } {
  const from = deepseekPricingPhase(nowMs)
  const { dayStartMs } = beijingParts(nowMs)
  // 候选切换点：今日起 32 天内每天的窗口边界；两侧相位相同的边界（周末或长假）跳过。
  // 覆盖长假与其前后的周末，不能只扫描一个星期。
  for (let day = 0; day <= 32; day++) {
    for (const minute of TRANSITION_MINUTES) {
      const t = dayStartMs + day * DAY_MS + minute * MINUTE_MS
      if (t <= nowMs) continue
      const to = deepseekPricingPhase(t)
      if (to !== from) return { to, inMs: t - nowMs }
    }
  }
  /* v8 ignore next -- 已公布的长假都少于 32 天，不可达 */
  throw new Error('nextPricingTransition: no transition within 32 days')
}
