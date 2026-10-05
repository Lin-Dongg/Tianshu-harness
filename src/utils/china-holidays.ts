/** Published national holiday periods, Beijing calendar dates.
 * 2025: https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
 * 2026: https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
 * Weekend make-up workdays stay off-peak under DeepSeek's Monday–Friday rule.
 * Update when the State Council publishes the next year's calendar.
 */
const PERIODS = [
  ['2025-01-01', '2025-01-01'], ['2025-01-28', '2025-02-04'],
  ['2025-04-04', '2025-04-06'], ['2025-05-01', '2025-05-05'],
  ['2025-05-31', '2025-06-02'], ['2025-10-01', '2025-10-08'],
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
] as const

export function isChinaPublicHoliday(date: string): boolean {
  return PERIODS.some(([start, end]) => date >= start && date <= end)
}
