/**
 * 星域评测题库（domain bank）—— 把「真实任务」沉淀为可复跑的评测题。
 *
 * 设计参照 Terminal-Bench（task = 指令 + 环境 + 测试 + oracle 解 + 领域/难度元数据，
 * 按跑测试判分；oracle 必须先过，否则题本身无效），落到本仓已有 benchmark 体系之上：
 *   · 环境   = git worktree 停在 **修复前一提交**（真实修复回滚）
 *   · 测试   = 真实修复**自带的参考测试**（RED 起点，也是判分器）
 *   · oracle = 真实修复提交（ground truth）
 *   · 判分   = 参考测试转绿 + 无回归（可复跑，不取信 agent 自述）
 *
 * 用途：固定「题 + 环境 + 判分」，把**星域提示词**当自变量——同一题换域跑，比较能力与轨迹。
 * 与 benchmark/tasks/*.json 的关系：那套是「功能自检」（无 ground truth）；
 * 本套是「能力评测」（有 oracle + 可判对错）。投影见 {@link toPilotSuite}。
 */

import { z } from 'zod'

export const domainTaskTypeSchema = z.enum(['diagnosis', 'guard', 'refactor', 'perf', 'feature', 'test'])
export const domainDifficultySchema = z.enum(['easy', 'medium', 'hard'])
/**
 * 成题生命周期（三段，诚实标状态）：
 *   candidate → 只有题面，未定 oracle/判分器
 *   ready     → oracle + grader + **RED 基线已确认**（测试在 baseRef 上确实红），待真跑
 *   validated → 已真跑并判过对错（validatedRuns 非空）
 */
export const domainTaskStatusSchema = z.enum(['validated', 'ready', 'candidate'])

export const domainBankTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** validated = 已真跑并判过对错；ready = 成题齐备待跑；candidate = 只有题面，未验证。 */
  status: domainTaskStatusSchema,
  taskType: domainTaskTypeSchema,
  difficulty: domainDifficultySchema,
  /** 给 agent 的题面——只描述症状/需求，不泄露修法（测试会拒收含提交号的题面）。 */
  symptom: z.string().min(1),
  /**
   * **题面是否已把 oracle 的参考测试（契约）交给 agent**。
   *
   * `true`  = 契约已给（工作区里放着 RED 参考测试）→ 测的是「**照契约实现**」。
   *           这类题**不得用于 harness / 模型的能力对比**——两侧拿到的信息量不等价。
   * `false` = 真实第一次解题（agent 未见题、无契约）→ 能力对比只能用这类。
   *
   * 必填无默认：逼作者显式想清楚这题是哪一类（2026-10-07 事故：三题全是 `true`，
   * 却被当成能力对比依据）。见 benchmark/domains/README.md。
   */
  contractGiven: z.boolean(),
  environment: z.object({
    kind: z.enum(['git-revert', 'blank']),
    /** worktree 起点（修复前一提交）。 */
    baseRef: z.string().min(1),
    /** ground truth：真实修复提交。 */
    oracleCommit: z.string().min(1).optional(),
  }),
  grader: z.object({
    command: z.string().min(1),
    /** 判分用的参考测试（从 oracle 提交取出，RED 起点）。 */
    referenceTests: z.array(z.string().min(1)),
    expected: z.literal('green'),
    /** 禁止 agent 改动的文件（防「改测试骗绿」）。 */
    mustNotTouch: z.array(z.string().min(1)).default([]),
  }),
  timeoutMs: z.number().int().positive(),
  tags: z.array(z.string().min(1)).default([]),
  provenance: z.object({
    source: z.enum(['real-fix', 'doc-candidate']),
    /** 证据路径（报告/数据），validated 必填。 */
    evidence: z.array(z.string().min(1)).default([]),
    oracleCommitMessage: z.string().optional(),
  }),
  /** validated 条目的真跑记录（candidate 必须为空——不许贴金）。 */
  validatedRuns: z.array(z.object({
    variant: z.string().min(1),
    model: z.string().min(1),
    verdict: z.enum(['pass', 'fail', 'timeout']),
    stats: z.string().optional(),
  })).default([]),
})

export const domainBankSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().optional(),
  tasks: z.array(domainBankTaskSchema),
})

export type DomainBank = z.infer<typeof domainBankSchema>
export type DomainBankTask = z.infer<typeof domainBankTaskSchema>

/** 题库 taskType → 既有 benchmark category（taskDefinitionSchema 的枚举）。 */
const CATEGORY_BY_TASK_TYPE = {
  diagnosis: 'repo_inspection',
  guard: 'code_edit',
  refactor: 'multi_file_refactor',
  perf: 'multi_file_refactor',
  feature: 'code_edit',
  test: 'test_repair',
} as const

/** 题库 → scripts/experiments/taiyi-variant-pilot.ts 消费的 suite 形状（{tasks:[...]}）。 */
export function toPilotSuite(
  bank: DomainBank,
  opts?: { status?: z.infer<typeof domainTaskStatusSchema>; ids?: string[] },
): { tasks: Array<{ id: string; title: string; category: string; prompt: string; timeoutMs: number; tags: string[] }> } {
  const tasks = bank.tasks
    .filter(t => (opts?.status ? t.status === opts.status : true))
    .filter(t => (opts?.ids ? opts.ids.includes(t.id) : true))
    .map(t => ({
      id: t.id,
      title: t.title,
      category: CATEGORY_BY_TASK_TYPE[t.taskType],
      prompt: t.symptom,
      timeoutMs: t.timeoutMs,
      tags: t.tags,
    }))
  return { tasks }
}
