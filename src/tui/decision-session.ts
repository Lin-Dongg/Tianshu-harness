import type { AgentLoop } from '../agent/loop.js'
import { readPlanSync, stripPlanChrome, rejectPlan } from '../plan/plan-store.js'
import { planRevision } from '../plan/plan-revision.js'
import { approvePlanWithGuards } from '../plan/plan-approval.js'
import { formatPlanReviewDate } from './format/plan-review.js'
import type { TuiApp } from './engine/app.js'
import type { PlanDecision, PlanDecisionResult, PlanReviewView } from './engine/decision-controller.js'

export function readPlanReviewView(cwd: string, slug: string): PlanReviewView {
  const doc = readPlanSync(cwd, slug)
  return doc ? { body: stripPlanChrome(doc.content).join('\n'), date: formatPlanReviewDate(doc.createdAt), revision: planRevision(doc.content), info: { slug: doc.slug, title: doc.title, options: doc.options } } : {}
}

const deliverySessions = new WeakMap<TuiApp, { epoch: number; deliveries: Map<string, DecisionDelivery> }>()

export function attachDecisionSession(app: TuiApp, current: () => AgentLoop, onPlan?: (slug: string) => void): void {
  const agent = current()
  // 面板接管提问的呈现：ask_user_question 的卡片改由面板结算时归档，
  // 不再在工具结果到达时提前落进对话历史（见 TuiApp.handleToolResult）。
  app.decisionPanelsAttached = true
  agent.onPlanApprovalRequested = info => {
    const generation = app.runGen, epoch = app.decisions.epoch
    setImmediate(() => {
      if (current() !== agent || app.runGen !== generation || app.decisions.epoch !== epoch) return
      const view = readPlanReviewView(agent.cwd, info.slug)
      app.openPlanApprovalPanel({ ...info, ...view.info }, view)
      onPlan?.(info.slug)
    })
  }
  agent.onAskUserQuestionRequested = info => {
    const generation = app.runGen, epoch = app.decisions.epoch
    setImmediate(() => {
      if (current() === agent && app.runGen === generation && app.decisions.epoch === epoch) app.openAskUserQuestionPanel(info)
    })
  }
  const state = deliverySessions.get(app) ?? { epoch: app.decisions.epoch, deliveries: new Map<string, DecisionDelivery>() }
  deliverySessions.set(app, state)
  app.onPlanDecision = decision => {
    if (state.epoch !== app.decisions.epoch) { state.deliveries.clear(); state.epoch = app.decisions.epoch }
    return settlePlanDecision(app, current, decision, state.deliveries)
  }
}

interface DecisionDelivery { signature: string; revision: string; status: string; text: string }

export async function settlePlanDecision(app: TuiApp, current: () => AgentLoop, decision: PlanDecision,
  deliveries = new Map<string, DecisionDelivery>()): Promise<PlanDecisionResult> {
  const agent = current(), cwd = agent.cwd, epoch = app.decisions.epoch
  const stillCurrent = () => current() === agent && app.decisions.epoch === epoch && app.decisions.plan?.id === decision.requestId
  if (app.isAgentBusy) return { ok: false, error: '模型正在收尾，请稍后重试' }
  const doc = readPlanSync(cwd, decision.info.slug)
  const signature = JSON.stringify([decision.info.slug, decision.revision, decision.action, decision.feedback])
  const pending = deliveries.get(decision.requestId)
  if (pending) {
    if (pending.signature !== signature) return { ok: false, error: '上次决定已保存，请重试原操作以继续发送执行消息' }
    if (!doc || doc.status !== pending.status || planRevision(doc.content) !== pending.revision) {
      return { ok: false, error: '已保存的决定对应计划已变化，请在计划列表确认当前状态' }
    }
    await app.submitDecisionText(pending.text)
    deliveries.delete(decision.requestId)
    return { ok: true }
  }
  if (!doc || doc.status !== 'submitted') return { ok: false, error: '计划已失效或已处理，请在计划列表确认当前状态' }
  if (decision.revision && decision.revision !== planRevision(doc.content)) {
    return { ok: false, error: '计划内容已变化，已刷新卡片，请重新确认', refresh: {
      ...readPlanReviewView(cwd, doc.slug), info: { ...decision.info, title: doc.title, options: doc.options },
    } }
  }
  const expected = decision.revision ?? planRevision(doc.content)
  let text = '', saved: typeof doc
  if (decision.action === 'approve' || decision.action.startsWith('approve:')) {
    const idx = decision.action.startsWith('approve:') ? Number(decision.action.slice(8)) : undefined
    const option = idx === undefined ? doc.options?.find(o => o.recommended === true || (o.recommended === undefined && /recommended/i.test(o.label))) ?? doc.options?.[0] : doc.options?.[idx]
    if (idx !== undefined && (!Number.isInteger(idx) || !option)) return { ok: false, error: '方案不存在，请重新确认' }
    const result = await approvePlanWithGuards(cwd, doc.slug, option?.label, expected, stillCurrent)
    if (!result.ok) return { ok: false, error: result.reason, refresh: readPlanReviewView(cwd, doc.slug) }
    if (!stillCurrent()) return { ok: false, error: '会话已切换，未发送执行消息' }
    saved = result.approved; text = result.kickoff
    agent.setActivePlan({ slug: doc.slug, title: saved.title, selectedApproach: option?.label })
    app.commitStatic(`计划「${saved.title}」已批准${option ? ` · ${option.label}` : ''}。`)
  } else {
    if (!['reject', 'reject-exit', '__reject_comment__'].includes(decision.action)) return { ok: false, error: '未知审批操作' }
    const rejected = await rejectPlan(cwd, doc.slug, expected, stillCurrent)
    if (!rejected) return { ok: false, error: '计划内容或状态已变化，请重新确认', refresh: readPlanReviewView(cwd, doc.slug) }
    if (!stillCurrent()) return { ok: false, error: '会话已切换，未发送反馈消息' }
    saved = rejected
    if (decision.action === 'reject-exit') agent.exitPlanMode()
    app.commitStatic(`计划「${doc.title}」已驳回${decision.feedback ? '（含反馈）' : ''}。`)
    if (decision.feedback) text = `User rejected the plan. Feedback:\n\n${decision.feedback}\n\nRevise the plan in \`.rivet/plans/${doc.slug}.md\`, then call plan action=submit again.`
  }
  if (text) {
    // Save delivery before sending: a failed send must retry the message, never repeat approval.
    deliveries.set(decision.requestId, { signature, revision: planRevision(saved.content), status: saved.status, text })
    await app.submitDecisionText(text)
    deliveries.delete(decision.requestId)
  }
  return { ok: true }
}
