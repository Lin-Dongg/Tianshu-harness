/**
 * workers.patcherTier / escalationCap 的加载期修复。
 *
 * 背景（2026-10-06 用户报告）：某次写入把 profile 名 'cheap-flash' 填进了
 * patcherTier。这类值非法会让整份 config 的 zod 校验失败，而 loadConfig 是
 * fail-loud（绝不静默回退）——于是**一个字段写错就让应用完全起不来**（用户：
 * 更新后打不开）。
 *
 * 这两个字段是「值域封闭的开关」：非法值不代表任何可用意图（没人真要
 * 'cheap-flash' 这个 tier），回落 schema 默认安全且无歧义。修复随 loadConfig 的
 * 写回落盘，用户下次启动自动恢复，无需手改配置文件。幂等。
 *
 * 沿接缝外提（同 retry-schema.ts / interrupt-marker-config.ts 先例）——manager.ts
 * 是点名巨石，新迁移不落在它身上，只留一行挂载。
 */
import { WORKER_PATCHER_TIERS, WORKER_ESCALATION_CAPS } from './schema.js'

/**
 * 把枚举外的 tier 值回落默认。合法值原样保留。
 * Mutates `raw` in place. Returns true if any value was changed.
 */
export function migrateInvalidWorkerTiers(raw: Record<string, unknown>): boolean {
  const workers = raw.workers
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) return false
  const w = workers as Record<string, unknown>
  let changed = false
  if (w.patcherTier !== undefined && !(WORKER_PATCHER_TIERS as readonly unknown[]).includes(w.patcherTier)) {
    w.patcherTier = 'cheap'
    changed = true
  }
  if (w.escalationCap !== undefined && !(WORKER_ESCALATION_CAPS as readonly unknown[]).includes(w.escalationCap)) {
    w.escalationCap = 'off'
    changed = true
  }
  return changed
}
