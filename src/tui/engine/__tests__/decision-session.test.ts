import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeApp } from './_harness.js'
import { attachDecisionSession } from '../../decision-session.js'
import { PLAN_TOOL } from '../../../tools/plan.js'
import { ASK_USER_QUESTION_TOOL } from '../../../tools/ask-user-question.js'
import { readPlanSync, writePlan, approvePlan, rejectPlan } from '../../../plan/plan-store.js'
import { approvePlanWithGuards } from '../../../plan/plan-approval.js'
import { planRevision } from '../../../plan/plan-revision.js'
import type { AgentLoop } from '../../../agent/loop.js'
import { readFileSync } from 'node:fs'

const tick = () => new Promise<void>(r => setTimeout(r, 20))
async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 3000
  while (!ready() && Date.now() < deadline) await tick()
  assert.ok(ready(), 'decision settlement did not finish')
}
const body = ['## 需求提炼', '恢复用户决策卡片，批准后执行已选方案。', '## 根因分析', '渲染和请求状态混在一起导致状态丢失。',
  '## 实现方案', '把待处理请求和界面可见状态分开存储。', '```mermaid', 'flowchart TD', 'A --> B', '```',
  '## 反证复现', '验证收起卡片后请求仍可恢复，非推荐方案选择准确。', '## 验证', '用真实工具、键盘选择和异步回调验证闭环。'].join('\n')

test('actual plan tool and production binding approve the nonrecommended approach and kick off once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'decision-plan-'))
  const { app, stdin } = makeApp()
  let selected = '', kickoff = ''
  const agent = { cwd, setActivePlan: (p: { selectedApproach: string }) => { selected = p.selectedApproach }, exitPlanMode() {} } as unknown as AgentLoop
  try {
    attachDecisionSession(app, () => agent)
    app.onSubmit(text => { kickoff = text })
    const result = await PLAN_TOOL.execute({ cwd, toolUseId: 'plan-tool', input: { action: 'submit', title: 'Decision Plan', plan: body,
      options: [{ label: '小范围', description: '实现目标', recommended: true, recommendation_reason: '改动更少' }, { label: '大范围', description: '额外扩展' }] },
      onPlanSubmitted: info => agent.onPlanApprovalRequested?.(info) })
    assert.notEqual(result.isError, true, result.content)
    await tick()
    assert.equal(app.pendingPlanApproval?.requestId, 'plan-tool')
    assert.ok(app.decisions.plan?.view.revision)
    stdin.dataHandler!('\x1B[B'); stdin.dataHandler!('\r'); stdin.dataHandler!('\r')
    await waitFor(() => app.decisions.count === 0 || !!app.decisions.plan?.error)
    assert.equal(selected, '大范围')
    assert.match(kickoff, /Selected approach: 大范围/)
    assert.equal(readPlanSync(cwd, 'decision-plan')?.status, 'approved')
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose(); await rm(cwd, { recursive: true, force: true }) }
})

test('production question binding preserves recommendation, requests and answers through a normal user message', async () => {
  const { app, stdin } = makeApp()
  const agent = { cwd: '/unused' } as AgentLoop
  let answer = ''
  try {
    attachDecisionSession(app, () => agent)
    app.onSubmit(text => { answer = text })
    const result = await ASK_USER_QUESTION_TOOL.execute({ cwd: '/unused', toolUseId: 'ask-tool',
      input: { questions: [{ prompt: '选择范围', options: [
        { label: '仅审批', recommended: true, recommendation_reason: '目标清晰且风险低' }, { label: '所有交互' },
      ] }, { prompt: '补充要求' }] }, onAskUserQuestion: info => agent.onAskUserQuestionRequested?.(info) })
    assert.equal(result.endTurn, true)
    await tick()
    assert.equal(app.decisions.question?.id, 'ask-tool')
    assert.equal(app.decisions.question?.questions[0]?.optionDetails?.[0]?.recommendationReason, '目标清晰且风险低')
    stdin.dataHandler!('2'); stdin.dataHandler!('\r'); stdin.dataHandler!('保持兼容'); stdin.dataHandler!('\r'); stdin.dataHandler!('\r')
    await tick()
    assert.equal(answer, '选择范围 → 所有交互\n补充要求 → 保持兼容')
    assert.equal(app.pendingAskFlow, undefined)
  } finally { app.dispose() }
})

test('changed plan refreshes the displayed options and requires a new decision; approval boundary checks revision', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'decision-revision-'))
  const { app, stdin } = makeApp()
  const agent = { cwd, setActivePlan() {}, exitPlanMode() {} } as unknown as AgentLoop
  try {
    attachDecisionSession(app, () => agent)
    await writePlan(cwd, 'revision', body)
    agent.onPlanApprovalRequested?.({ requestId: 'p1', slug: 'revision', title: 'Version 1' }); await tick()
    const old = app.decisions.plan!.view.revision!
    await writePlan(cwd, 'revision', body + '\n新增约束。', [{ label: '新方案', description: '更新' }, { label: '其他', description: '比较' }])
    stdin.dataHandler!('\r'); await tick()
    assert.equal(readPlanSync(cwd, 'revision')?.status, 'submitted')
    assert.match(app.decisions.plan!.error!, /已变化/)
    assert.equal(app.pendingPlanApproval?.options?.[0]?.label, '新方案')
    assert.notEqual(app.decisions.plan?.view.revision, old)
    const result = await approvePlanWithGuards(cwd, 'revision', undefined, old)
    assert.equal(result.ok, false)
    assert.equal(readPlanSync(cwd, 'revision')?.status, 'submitted')
    assert.equal(planRevision(readPlanSync(cwd, 'revision')!.content), app.decisions.plan?.view.revision)
  } finally { app.dispose(); await rm(cwd, { recursive: true, force: true }) }
})

test('deferred production callbacks are discarded after session change and abort', async () => {
  const { app } = makeApp()
  const agent = { cwd: '/unused' } as AgentLoop
  try {
    attachDecisionSession(app, () => agent)
    agent.onAskUserQuestionRequested?.({ requestId: 'late', questions: [{ id: 'q', prompt: 'late', options: [], allowMultiple: false }] })
    app.setCwd('/new-session'); await tick()
    assert.equal(app.decisions.count, 0)
    agent.onPlanApprovalRequested?.({ requestId: 'late-plan', slug: 'gone', title: 'late' })
    ;(app as any).handleAbort(); await tick()
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose() }
})

test('all runtime replacements rebind the production decision callbacks', async () => {
  // Optional callbacks silently return undefined when the replacement runtime loses its binding.
  const bootstrap = readFileSync(new URL('../../../bootstrap.ts', import.meta.url), 'utf8')
  assert.equal((bootstrap.match(/ctx\.agent = agent/g) ?? []).length, 3)
  assert.equal((bootstrap.match(/ctx\.agent = agent\s+ctx\.onAgentRuntimeChanged\?\.\(\)/g) ?? []).length, 3)
  const main = readFileSync(new URL('../../../main.ts', import.meta.url), 'utf8')
  assert.match(main, /ctx!\.onAgentRuntimeChanged = attachDecisions/)
  const { app } = makeApp()
  let agent = { cwd: '/old' } as AgentLoop
  try {
    attachDecisionSession(app, () => agent)
    const old = agent
    agent = { cwd: '/new' } as AgentLoop
    attachDecisionSession(app, () => agent)
    old.onAskUserQuestionRequested?.({ requestId: 'old', questions: [{ id: 'q', prompt: 'old', options: [], allowMultiple: false }] })
    agent.onAskUserQuestionRequested?.({ requestId: 'new', questions: [{ id: 'q', prompt: 'new', options: [], allowMultiple: false }] })
    await tick()
    assert.equal(app.decisions.count, 1)
    assert.equal(app.decisions.question?.id, 'new')
  } finally { app.dispose() }
})

for (const action of ['approve', 'feedback'] as const) test(`${action}: delivery failure retries the saved decision without approving twice`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'decision-retry-'))
  const { app, stdin } = makeApp()
  let activations = 0, attempts = 0, sent = ''
  const agent = { cwd, setActivePlan() { activations++ }, exitPlanMode() {} } as unknown as AgentLoop
  try {
    attachDecisionSession(app, () => agent)
    await writePlan(cwd, 'retry', body)
    agent.onPlanApprovalRequested?.({ requestId: 'retry', slug: 'retry', title: 'Retry' }); await tick()
    app.submitDecisionText = async text => { if (++attempts === 1) throw new Error('发送失败'); sent = text }
    if (action === 'feedback') { stdin.dataHandler!('f'); stdin.dataHandler!('缩小范围') }
    stdin.dataHandler!('\r'); await waitFor(() => !!app.decisions.plan?.error)
    assert.match(app.decisions.plan!.error!, /发送失败/)
    const saved = readPlanSync(cwd, 'retry')!.content
    stdin.dataHandler!('\r'); await waitFor(() => app.decisions.count === 0)
    assert.equal(attempts, 2)
    assert.equal(readPlanSync(cwd, 'retry')!.content, saved, 'retry must not rewrite approval/rejection')
    assert.equal(activations, action === 'approve' ? 1 : 0)
    assert.match(sent, action === 'approve' ? /开始执行/ : /缩小范围/)
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose(); await rm(cwd, { recursive: true, force: true }) }
})

test('a structured answer bypasses mission preview, worker routing and slash command interpretation', async () => {
  const { app, stdin } = makeApp()
  let answer = '', literal = false
  try {
    const agent = { cwd: '/unused' } as AgentLoop
    attachDecisionSession(app, () => agent)
    app.onSubmit((text, _images, opts) => { answer = text; literal = opts?.literalText === true })
    app.openAskUserQuestionPanel({ requestId: 'literal', questions: [{ prompt: '输入要求', id: 'q', options: [], allowMultiple: false }] })
    ;(app as any).viewingWorkerId = 'some-worker'
    stdin.dataHandler!('\r'); stdin.dataHandler!('/some-command @file:missing #任务'); stdin.dataHandler!('\r'); stdin.dataHandler!('\r'); await tick()
    assert.equal(answer, '/some-command @file:missing #任务')
    assert.equal(literal, true)
    assert.equal((app as any).contractPreview, null)
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose() }
})

test('the actual plan storage boundary rejects mismatched displayed versions for both decisions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'decision-store-version-'))
  try {
    await writePlan(cwd, 'guard', body)
    const previous = planRevision(readPlanSync(cwd, 'guard')!.content)
    await writePlan(cwd, 'guard', body + '\n已修改。')
    assert.equal(await approvePlan(cwd, 'guard', previous), null)
    assert.equal(await rejectPlan(cwd, 'guard', previous), null)
    assert.equal(readPlanSync(cwd, 'guard')!.status, 'submitted')
    const source = readFileSync(new URL('../../../plan/plan-approval.ts', import.meta.url), 'utf8')
    assert.match(source, /await approvePlan\(cwd, slug, expectedRevision, canCommit\)/, 'revision must reach the actual storage consumer')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

for (const worker of [false, true]) test(`structured answers bypass ${worker ? 'worker routing' : 'mission preview'} at the actual submission entrance`, async () => {
  const { app, stdin } = makeApp()
  let submitted = ''
  const text = worker ? '普通回答' : '@file:missing #任务 ' + '完整实现要求。'.repeat(80)
  try {
    app.onSubmit(value => { submitted = value })
    app.openAskUserQuestionPanel({ requestId: 'bypass', questions: [{ id: 'q', prompt: '补充要求', options: [], allowMultiple: false }] })
    if (worker) (app as any).viewingWorkerId = 'a-worker'
    stdin.dataHandler!('\r'); stdin.dataHandler!('\x1b[200~' + text + '\x1b[201~'); stdin.dataHandler!('\r'); stdin.dataHandler!('\r')
    await waitFor(() => app.decisions.count === 0)
    assert.equal(submitted, text)
    assert.equal((app as any).contractPreview, null)
  } finally { app.dispose() }
})

test('a superseded request cannot approve or deliver even when the plan content is unchanged', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'decision-request-'))
  const { app } = makeApp()
  let submitted = false
  const agent = { cwd, setActivePlan() {}, exitPlanMode() {} } as unknown as AgentLoop
  try {
    attachDecisionSession(app, () => agent); app.onSubmit(() => { submitted = true })
    await writePlan(cwd, 'same', body)
    agent.onPlanApprovalRequested?.({ slug: 'same', title: 'same', requestId: 'old' }); await tick()
    const settling = app.decisions.settlePlan('approve')
    app.openPlanApprovalPanel({ slug: 'same', title: 'same', requestId: 'new' }, app.decisions.plan!.view)
    await settling
    assert.equal(app.decisions.plan!.id, 'new')
    assert.equal(readPlanSync(cwd, 'same')!.status, 'submitted')
    assert.equal(submitted, false)
  } finally { app.dispose(); await rm(cwd, { recursive: true, force: true }) }
})

test('replacing the model runtime preserves a saved decision awaiting delivery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'decision-rebind-retry-'))
  const { app } = makeApp()
  let agent = { cwd, setActivePlan() {}, exitPlanMode() {} } as unknown as AgentLoop
  let delivered = ''
  try {
    attachDecisionSession(app, () => agent); await writePlan(cwd, 'retry-model', body)
    agent.onPlanApprovalRequested?.({ slug: 'retry-model', title: 'retry', requestId: 'retry' }); await tick()
    app.submitDecisionText = async () => { throw new Error('发送失败') }
    await app.decisions.settlePlan('approve')
    assert.equal(readPlanSync(cwd, 'retry-model')!.status, 'approved')
    agent = { cwd, setActivePlan() {}, exitPlanMode() {} } as unknown as AgentLoop
    attachDecisionSession(app, () => agent)
    app.submitDecisionText = async text => { delivered = text }
    await app.decisions.settlePlan('approve')
    assert.match(delivered, /开始执行已批准方案/)
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose(); await rm(cwd, { recursive: true, force: true }) }
})
