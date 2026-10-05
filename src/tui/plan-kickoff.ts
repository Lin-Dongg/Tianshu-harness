import type { AgentLoop } from '../agent/loop.js'
import { approvePlanWithGuards } from '../plan/plan-approval.js'

/**
 * 批准计划并自动 kickoff 分波执行的共享闭环。slash `/plan-approve` 与 plan-picker
 * overlay 回车共用:approve → setActivePlan(注入指针 + 退出 plan mode)→ 提交 kickoff。
 * 返回 false 表示计划不存在(调用方据此报错)。
 */
export async function approvePlanAndKickoff(
  deps: {
    cwd: string
    agent: Pick<AgentLoop, 'setActivePlan'>
    submitToAgent?: (prompt: string) => void | Promise<void>
    notify: (content: string, isError?: boolean) => void
  },
  slug: string,
  resolvedApproach?: string,
  expectedRevision?: string,
): Promise<boolean> {
  const result = await approvePlanWithGuards(deps.cwd, slug, resolvedApproach, expectedRevision)
  if (!result.ok) {
    if (result.code === 'invalid-content') {
      deps.notify(`无法批准 **${result.title}** (\`${slug}\`)：${result.reason} 未写入 APPROVED 标记，也未启动执行。`, true)
    } else if (result.code === 'document-changed') {
      deps.notify(result.reason, true)
    } else {
      deps.notify(`Plan not found: "${slug}". Use /plan-list to see available plans.`, true)
    }
    return false
  }
  const { approved, driftNote, kickoff } = result
  deps.agent.setActivePlan({ slug, title: approved.title, selectedApproach: resolvedApproach })
  const approachLine = resolvedApproach ? `\nSelected approach: **${resolvedApproach}**` : ''
  const driftLine = driftNote
    ? `\n\n⚠ 锚点漂移复查:计划中有引用与当前工作区不符(已注入执行提示,执行方将以现实为准):\n${driftNote}`
    : ''
  deps.notify(
    `✅ Plan approved: **${approved.title}** (\`${slug}\`)${approachLine}\n\n方案指针已加载,正文在 \`.rivet/plans/${slug}.md\`。Plan Mode 已退出 — 开始自动分波执行。${driftLine}`,
  )
  await deps.submitToAgent?.(kickoff)
  return true
}
