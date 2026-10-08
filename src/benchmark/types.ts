import { z } from 'zod'

export const taskCategorySchema = z.enum([
  'repo_inspection',
  'code_edit',
  'test_repair',
  'multi_file_refactor',
  'session_recovery',
  'provider_conformance',
])

export const benchmarkStatusSchema = z.enum(['passed', 'failed', 'blocked'])

export const taskDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: taskCategorySchema,
  prompt: z.string().min(1),
  setupCommands: z.array(z.string().min(1)).default([]),
  successCommands: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive(),
  tags: z.array(z.string().min(1)).default([]),
  /**
   * 「契约已给」标记——只由星域题库投影（domain-bank.toPilotSuite）填入。
   * true = 题面已把 oracle 参考测试交给 agent，**禁作能力对比**（两侧信息量不等价）。
   * optional：历史 suite 文件（benchmark/tasks/*.json、docs/experiments/*）无此字段，
   * 缺省按未知处理；缺失不得被解读为 false。
   */
  contractGiven: z.boolean().optional(),
})

export const benchmarkFailureSchema = z.object({
  class: z.string().min(1),
  message: z.string().min(1),
  toolName: z.string().min(1).optional(),
})

export const benchmarkMetricsSchema = z.object({
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1).optional(),
  costUsd: z.number().nonnegative().optional(),
})

/** Per-arm speculation observe counters (mirror of session meta speculationStats). */
export const speculationArmStatsSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
})

/**
 * Session telemetry harvested from the spawned agent's session directory
 * (2026-08-07 测量回路 Phase 1)。executor 给每个任务钉一个独立
 * RIVET_SESSION_DIR，跑完从会话 meta（speculationStats/llmSpeculationEngine）
 * 与 cache-log.jsonl（provider 维度行）回收——此前这些数据落在 workspace
 * 对应的 slug 目录里，报告侧永远读不到。
 */
export const benchmarkSessionDataSchema = z.object({
  sessionId: z.string().min(1).optional(),
  /** Session meta model — cross-check that --model pinning actually took. */
  model: z.string().optional(),
  speculationStats: z.record(z.string(), speculationArmStatsSchema).optional(),
  llmSpeculationEngine: z.object({
    fired: z.number().int().nonnegative(),
    enqueued: z.number().int().nonnegative(),
    parseFailures: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }).optional(),
  cache: z.object({
    /** main-turn request count */
    requests: z.number().int().nonnegative(),
    input: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    /** weighted ΣcacheRead/Σinput over main rows, percent 0–100; null when no input */
    hitRatePct: z.number().nullable(),
    /** provider×model rollup — spark 与官方同 wire 模型 id 的对照主体 */
    byProviderModel: z.array(z.object({
      provider: z.string().optional(),
      model: z.string(),
      requests: z.number().int().nonnegative(),
      input: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      hitRatePct: z.number().nullable(),
    })),
  }).optional(),
})

export const benchmarkRunSchema = z.object({
  runId: z.string().min(1),
  suiteId: z.string().min(1),
  taskId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 邻居提示 A/B 开关状态（P2-3）：true = RIVET_NEIGHBOR_HINT=1 跑，缺省 = 关。 */
  hint: z.boolean().optional(),
  status: benchmarkStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  metrics: benchmarkMetricsSchema,
  failures: z.array(benchmarkFailureSchema).default([]),
  session: benchmarkSessionDataSchema.optional(),
})

export const capabilityMatrixRowSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  suiteId: z.string().min(1),
  runs: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  medianTurns: z.number().nonnegative(),
  medianToolCalls: z.number().nonnegative(),
  averageCostUsd: z.number().nonnegative(),
})

export type TaskCategory = z.infer<typeof taskCategorySchema>
export type BenchmarkStatus = z.infer<typeof benchmarkStatusSchema>
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>
export type BenchmarkFailure = z.infer<typeof benchmarkFailureSchema>
export type BenchmarkMetrics = z.infer<typeof benchmarkMetricsSchema>
export type BenchmarkSessionData = z.infer<typeof benchmarkSessionDataSchema>
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>
export type CapabilityMatrixRow = z.infer<typeof capabilityMatrixRowSchema>
