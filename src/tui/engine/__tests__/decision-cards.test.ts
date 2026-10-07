import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp as makeBaseApp, stripAnsi } from './_harness.js'
import { renderDecisionCard } from '../../format/decision-card.js'
import { getTheme } from '../../theme.js'
import { DecisionController } from '../decision-controller.js'
import type { PlanSubmittedInfo } from '../../../tools/types.js'

const plan: PlanSubmittedInfo = { requestId: 'p1', slug: 'plan', title: '修复状态', options: [
  { label: '第一方案', description: '较少改动', recommended: true, recommendationReason: '覆盖用户目标且改动最少' },
  { label: '第二方案', description: '扩大范围' },
] }
const questions = { requestId: 'q1', questions: [{ id: 'scope', prompt: '请选择范围', options: ['范围 A', '范围 B'], allowMultiple: false,
  optionDetails: [{ recommended: true, recommendationReason: '符合当前目标' }, {}] }] }
async function makeApp(opts: Parameters<typeof makeBaseApp>[0] = {}) {
  const h = makeBaseApp(opts)
  if (opts.renderer === 'fullscreen') {
    await (h.app as any).frontend.ready
    ;(h.app as any).frontend.startFullscreen(false)
    ;(h.app as any).overlay.setBorrowed(true)
    assert.equal((h.app as any).frontend.isFullscreen, true)
  }
  return h
}

const tick = () => new Promise<void>(r => setTimeout(r, 20))

for (const renderer of ['classic', 'fullscreen'] as const) {
  test(`${renderer}: decisions preempt help and frozen output, Down+Enter chooses the displayed option`, async () => {
    const { app, out, stdin } = await makeApp({ renderer })
    try {
      app.activateOverlay('help'); (app as any).setOutputFrozen(true); out.clear()
      let selected = ''
      app.onPlanDecision = async d => { selected = d.action; return { ok: true } }
      app.openPlanApprovalPanel(plan, { body: '# 正文', revision: 'rev1' })
      assert.equal(app.activeOverlayId(), null)
      assert.match(stripAnsi(out.chunks.join('')), /计划审批/)
      assert.match(stripAnsi(out.chunks.join('')), /推荐理由：覆盖用户目标/)
      stdin.dataHandler!('\x1B[B'); stdin.dataHandler!('\r'); await tick()
      assert.equal(selected, 'approve:1', 'Enter applies cursor, not recommendation')
      assert.equal(app.pendingPlanApproval, undefined)
    } finally { app.dispose() }
  })
  test(`${renderer}: collapse retains request, Tab restores it, final completion retains the card`, async () => {
    const { app, out, stdin } = await makeApp({ renderer })
    try {
      app.openPlanApprovalPanel(plan)
      stdin.dataHandler!('\x1B')
      assert.equal(app.pendingPlanApproval?.requestId, 'p1')
      assert.equal(app.decisions.focused, false)
      assert.match(stripAnsi(out.chunks.join('')), /Tab 返回卡片/)
      stdin.dataHandler!('\t')
      assert.equal(app.decisions.focused, true)
      app.callbacks.onTurnComplete({}, 1, true); await tick()
      assert.equal(app.pendingPlanApproval?.requestId, 'p1')
      assert.equal(app.decisions.focused, true)
    } finally { app.dispose() }
  })
  test(`${renderer}: question editor and selection survive new requests and permission preemption`, async () => {
    const { app, stdin } = await makeApp({ renderer })
    try {
      app.setInput('原输入草稿'); app.openAskUserQuestionPanel(questions)
      stdin.dataHandler!('3'); stdin.dataHandler!('自定义')
      const item = app.decisions.question!
      app.openAskUserQuestionPanel({ ...questions, requestId: 'q2' })
      assert.equal(item.editor.value, '自定义')
      const pending = app.callbacks.onApprovalRequired!('permission', 'bash', { command: 'echo test' })
      stdin.dataHandler!('n'); await pending
      assert.equal(item.editor.value, '自定义')
      assert.equal(app.decisions.editing, true)
      stdin.dataHandler!('\x1B'); stdin.dataHandler!('\x1B')
      assert.equal(app.decisions.focused, false)
      assert.equal((app as any).inputLine.value, '原输入草稿')
    } finally { app.dispose() }
  })
}

test('asynchronous decisions gate duplicates, preserve errors, and ignore superseded completions', async () => {
  const { app, stdin, out } = await makeApp()
  try {
    let complete!: (r: { ok: true } | { ok: false; error: string }) => void
    let calls = 0
    app.onPlanDecision = () => { calls++; return new Promise(r => { complete = r }) }
    app.openPlanApprovalPanel(plan)
    stdin.dataHandler!('\r'); stdin.dataHandler!('\r')
    assert.equal(calls, 1)
    complete({ ok: false, error: '磁盘暂不可写' }); await tick()
    assert.equal(app.decisions.plan?.error, '磁盘暂不可写')
    assert.equal(app.decisions.plan?.submitting, false)
    stdin.dataHandler!('\r')
    app.openPlanApprovalPanel({ ...plan, requestId: 'p2' }, { revision: 'new' })
    out.clear(); complete({ ok: true }); await tick()
    assert.doesNotMatch(stripAnsi(out.chunks.join('')), /计划「修复状态」· 已批准/, 'stale completion must not write a success record into the current session')
    assert.equal(app.pendingPlanApproval?.requestId, 'p2', 'old completion cannot remove new revision')
    stdin.dataHandler!('\r'); app.setCwd('/other-project'); complete({ ok: true }); await tick()
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose() }
})

test('questions are FIFO and ahead of plans; answering pauses approval until the model finishes', async () => {
  let answer!: () => void
  const controller = new DecisionController({ changed() {}, reveal() {}, preview() {}, participate() {}, record() {},
    plan: async () => ({ ok: true }), answer: () => new Promise<void>(r => { answer = r }) })
  controller.openPlan(plan)
  controller.openQuestions(questions)
  controller.openQuestions(questions)
  controller.openQuestions({ ...questions, requestId: 'q2' })
  assert.equal(controller.count, 3)
  controller.chooseQuestion('1')
  const first = controller.submitAnswers(); answer(); await first
  assert.equal(controller.active?.id, 'q2')
  const second = controller.submitAnswers(); answer(); await second
  assert.equal(controller.active, undefined, 'pending plan cannot approve while answers are being processed')
  controller.setBusy(false)
  assert.equal((controller.active as { id: string } | undefined)?.id, 'p1')
})

for (const renderer of ['classic', 'fullscreen'] as const) for (const [cols, rows] of [[40, 10], [80, 24]]) {
  test(`${renderer} ${cols}x${rows}: selected action and footer survive resize and long content`, async () => {
    const { app, stdin, out } = await makeApp({ renderer, cols, rows })
    try {
      app.openAskUserQuestionPanel(questions)
      stdin.dataHandler!('\x1B[B')
      const screen = stripAnsi(out.chunks.join(''))
      assert.match(screen, /范围 B/)
      assert.match(screen, /Enter/)
      out.columns = 35; out.rows = 9; (app as any).rerender()
      assert.equal(app.decisions.question?.cursor, 1)
      assert.equal(app.decisions.count, 1)
    } finally { app.dispose() }
  })
}

test('screen reader retains decision text and a malformed plain reply creates no executable option', async () => {
  const { app, out } = await makeApp()
  try {
    app.setScreenReader(true); out.clear(); app.openAskUserQuestionPanel(questions)
    assert.match(stripAnsi(out.chunks.join('')), /请选择范围/)
    assert.match(stripAnsi(out.chunks.join('')), /范围 A/)
    app.decisions.clear(); app.callbacks.onTextDelta('请选择 1. 全部批准 2. 自动执行')
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose() }
})

for (const [width, height] of [[35, 5], [40, 8], [80, 18]]) test(`card ${width}x${height}: long options stay within the viewport and keep focus and hints`, async () => {
  const { app } = await makeApp()
  try {
    app.openAskUserQuestionPanel({ ...questions, questions: [{ ...questions.questions[0]!, prompt: '长问题'.repeat(20), options: ['选项一'.repeat(20), '选项二'.repeat(20)] }] })
    const item = app.decisions.question!; item.cursor = 1
    const lines = renderDecisionCard(item, width!, height!, getTheme(), 1)
    assert.ok(lines.length <= height!, `${lines.length} rows exceeds ${height}`)
    assert.match(stripAnsi(lines.filter(l => l.decisionPart === 'action').map(l => l.text).join('')), /选项二/)
    assert.match(stripAnsi(lines.find(l => l.decisionPart === 'footer')!.text), /Enter/)
  } finally { app.dispose() }
})

test('a pending card survives ordinary overlay settlement and question send failure can be retried', async () => {
  const { app, stdin } = await makeApp()
  let calls = 0
  try {
    app.onSubmit(async () => { if (++calls === 1) throw new Error('暂时不可发送') })
    app.openAskUserQuestionPanel(questions)
    app.activateOverlay('help'); stdin.dataHandler!('\x1b')
    assert.equal(app.decisions.count, 1)
    stdin.dataHandler!('2'); stdin.dataHandler!('\r'); await tick()
    assert.match(app.decisions.question!.error!, /暂时不可发送/)
    assert.equal(app.busy, false)
    stdin.dataHandler!('\r'); stdin.dataHandler!('\r'); await tick()
    assert.equal(calls, 2); assert.equal(app.decisions.count, 0)
  } finally { app.dispose() }
})

test('settled IDs cannot resurrect cards; repeated plan notifications preserve collapsed focus', async () => {
  const { app } = await makeApp()
  try {
    app.onPlanDecision = async () => ({ ok: true })
    app.onSubmit(() => {})
    app.openPlanApprovalPanel(plan); app.decisions.collapse(); app.openPlanApprovalPanel(plan)
    assert.equal(app.decisions.focused, false)
    app.decisions.restore(); await app.decisions.settlePlan('approve:1')
    app.openPlanApprovalPanel(plan)
    assert.equal(app.decisions.count, 0)
    app.openAskUserQuestionPanel(questions)
    app.decisions.chooseQuestion('0'); await app.decisions.submitAnswers()
    app.openAskUserQuestionPanel(questions)
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose() }
})

test('custom answer draft survives Esc and is not treated as an answered question until confirmed', async () => {
  const { app, stdin } = await makeApp()
  try {
    app.openAskUserQuestionPanel({ ...questions, questions: [...questions.questions, { id: 'other', prompt: '补充', options: [], allowMultiple: false }] })
    stdin.dataHandler!('3'); stdin.dataHandler!('未完成的自定义'); stdin.dataHandler!('\x1b')
    stdin.dataHandler!('\x1b[C'); stdin.dataHandler!('\x1b[D'); stdin.dataHandler!('3')
    assert.equal(app.decisions.question!.editor.value, '未完成的自定义')
    assert.equal(app.decisions.question!.drafts[0]!.otherSelected, false)
  } finally { app.dispose() }
})

test('moving the option cursor cancels an armed Goal approval countdown without submitting', async () => {
  const { app, stdin } = await makeApp()
  try {
    app.openPlanApprovalPanel(plan); app.armPlanAutoApprove(plan.slug, 60_000)
    stdin.dataHandler!('\x1b[B')
    assert.equal(app.planAutoApproveSlug, undefined)
    assert.equal(app.pendingPlanApproval?.requestId, 'p1')
  } finally { app.dispose() }
})

test('legacy choices explicitly disclose a missing recommendation reason without fabricating a recommendation', async () => {
  const { app, out } = await makeApp()
  try {
    app.openAskUserQuestionPanel({ ...questions, questions: [{ ...questions.questions[0]!, optionDetails: undefined }] })
    assert.match(stripAnsi(out.chunks.join('')), /旧记录未提供推荐理由/)
    assert.equal(app.decisions.question!.drafts[0]!.selected.length, 0)
    app.decisions.clear(); out.clear()
    app.openPlanApprovalPanel({ ...plan, options: [{ label: 'A', description: 'a', recommended: true, recommendationReason: '合理' }, { label: 'B (Recommended)', description: 'b', recommended: false }] })
    assert.equal(app.decisions.plan!.cursor, 0)
  } finally { app.dispose() }
})

for (const renderer of ['classic', 'fullscreen'] as const) test(`${renderer}: plan detail returns to the same cursor and later requests do not replace it`, async () => {
  const { app, stdin } = await makeApp({ renderer })
  try {
    app.registerOverlays({ pagerContent: () => ({ content: '完整计划正文', page: 0 }) })
    app.openPlanApprovalPanel(plan)
    stdin.dataHandler!('\x1b[B'); stdin.dataHandler!('v')
    assert.equal(app.activeOverlayId(), 'pager')
    app.openPlanApprovalPanel({ ...plan, requestId: 'p2', slug: 'second' })
    assert.equal(app.activeOverlayId(), 'pager')
    assert.equal(app.decisions.count, 2)
    stdin.dataHandler!('\x1b')
    assert.equal(app.activeOverlayId(), null)
    assert.equal(app.decisions.plan!.id, 'p1')
    assert.equal(app.decisions.plan!.cursor, 1)
    assert.equal(app.decisions.focused, true)
  } finally { app.dispose() }
})

// ── 提问卡归档：底部面板是唯一活动呈现，卡片等面板结算/用户发言时再落进历史 ──

for (const renderer of ['classic', 'fullscreen'] as const) {
  test(`${renderer}: 提问卡不在面板存续期间落历史，用户发言后归档一次`, async () => {
    const { app } = await makeApp({ renderer })
    try {
      app.decisionPanelsAttached = true
      app.onSubmit(() => {})
      app.openAskUserQuestionPanel(questions)
      app.callbacks.onToolResult('q1', 'ask_user_question', '[等待你的回复…]', false, undefined, '请选择范围\n\n  1. 范围 A\n  2. 范围 B')
      await tick()
      assert.equal(app.decisions.question?.id, 'q1', '面板仍持有该提问')
      assert.doesNotMatch(stripAnsi((app as any).commit.getContent()), /需要你的回答/, '面板存续期间不落第二张卡片')
      app.submitText('范围 A')
      await tick()
      const archived = stripAnsi((app as any).commit.getContent()).match(/转入讨论/g) ?? []
      assert.equal(archived.length, 1, '发言后恰好归档一次')
      app.submitText('再说一句')
      await tick()
      assert.equal((stripAnsi((app as any).commit.getContent()).match(/转入讨论/g) ?? []).length, 1, '不重复归档')
    } finally { app.dispose() }
  })

  test(`${renderer}: 未挂载决策面板时提问卡仍直接落历史`, async () => {
    const { app } = await makeApp({ renderer })
    try {
      app.callbacks.onToolResult('q9', 'ask_user_question', '[等待你的回复…]', false, undefined, '请选择范围\n\n  1. 范围 A\n  2. 范围 B')
      await tick()
      assert.match(stripAnsi((app as any).commit.getContent()), /需要你的回答/)
    } finally { app.dispose() }
  })
}
