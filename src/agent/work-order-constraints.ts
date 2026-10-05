import { PLAN_CONSTRAINT_PREFIX } from './plan-constraints.js'

/** Per-task constraint budget. Constraints render verbatim into the worker
 *  prompt, so an unbounded list would push out the objective it qualifies. */
const MAX_TASK_CONSTRAINTS = 12
/** 单条约束字符上限（含样板/任务级）。导出供 plan-constraints.ts 渲染器对齐——
 *  渲染器必须自己保证产出 ≤ 此值并带截断指针，避免此处无声再切一刀。 */
export const MAX_TASK_CONSTRAINT_CHARS = 400

/**
 * Profile discipline plus the dispatcher's task-level constraints.
 *
 * Appends rather than replaces: the profile lines carry the read-only and
 * report-shape discipline, and a caller supplying task constraints is adding a
 * requirement, not waiving those. Blank and duplicate entries are dropped so a
 * caller echoing a boilerplate line cannot double it.
 */
export function withTaskConstraints(base: string[], task?: string[]): string[] {
  if (!task?.length) return base
  const seen = new Set(base)
  const extra: string[] = []
  // D3 预算分级（契约传导回流 2026-09-21）：计划级条目（PLAN_CONSTRAINT_PREFIX
  // 指纹，如 [计划反目标]/[计划待验证假设·执行期先验证]）**不占任务级 12 条预算、
  // 不做 400 字截断**——它们是执行语义的权威来源，被任务级条目挤掉或截半，等于
  // worker 在缺契约的情况下自行发挥。任务级（本波情报、跨波回执等）仍按
  // 12 条 × 400 字裁剪，避免工单被情报噪声淹没。
  // 两遍扫描而非单遍分支：顺序无关（调用方传入顺序不再影响谁被保下来）。
  for (const raw of task) {
    if (!raw.startsWith(PLAN_CONSTRAINT_PREFIX)) continue
    const item = raw.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    extra.push(item)
  }
  let taskLevelCount = 0
  for (const raw of task) {
    if (raw.startsWith(PLAN_CONSTRAINT_PREFIX)) continue
    const item = raw.trim().slice(0, MAX_TASK_CONSTRAINT_CHARS)
    if (!item || seen.has(item)) continue
    seen.add(item)
    extra.push(item)
    if (++taskLevelCount >= MAX_TASK_CONSTRAINTS) break
  }
  return [...base, ...extra]
}
