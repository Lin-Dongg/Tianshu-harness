import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeApp as makeBaseApp, stripAnsi } from './_harness.js'
import { attachDecisionSession } from '../../decision-session.js'
import { ASK_USER_QUESTION_TOOL } from '../../../tools/ask-user-question.js'
import { UIHistory } from '../../ui-history.js'
import type { AgentLoop } from '../../../agent/loop.js'
import { displayWidth } from '../../width.js'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20))

async function makeApp(options: Parameters<typeof makeBaseApp>[0] = {}) {
  const result = makeBaseApp(options)
  await (result.app as any).frontend.ready
  if (options.renderer === 'fullscreen') {
    ;(result.app as any).frontend.startFullscreen(false)
    ;(result.app as any).overlay.setBorrowed(true)
    ;(result.app as any).commit.setOutputEnabled(false)
  }
  assert.equal((result.app as any).frontend.isFullscreen, options.renderer === 'fullscreen')
  return result
}

async function ask(app: ReturnType<typeof makeBaseApp>['app'], agent: AgentLoop, id: string, question: string) {
  const input = { question, options: [
    { label: '范围 A', recommended: true, recommendation_reason: '符合当前目标' }, { label: '范围 B' },
  ] }
  app.callbacks.onToolUse(id, 'ask_user_question', input)
  const result = await ASK_USER_QUESTION_TOOL.execute({ cwd: agent.cwd, toolUseId: id, input,
    onAskUserQuestion: info => agent.onAskUserQuestionRequested?.(info) })
  app.callbacks.onToolResult(id, 'ask_user_question', result.content, false, undefined, result.uiContent)
  await tick()
}

for (const renderer of ['classic', 'fullscreen'] as const) {
  test(`${renderer}: unanswered question survives normal exit and reopening history`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ask-exit-'))
    const { app } = await makeApp({ renderer })
    try {
      const path = join(dir, 'history.jsonl')
      await app.setUIHistorySession(path)
      const agent = { cwd: dir } as AgentLoop
      attachDecisionSession(app, () => agent)
      await ask(app, agent, 'exit', '退出前的问题')
      app.dispose(); app.dispose()
      const history = await UIHistory.open(path)
      const cards = (await history.page(0)).filter(r => r.name === 'ask_user_question')
      assert.equal(cards.length, 1, '退出必须且只能持久化一次')
      assert.match(cards[0]!.text, /退出前的问题/)
      assert.match(cards[0]!.text, /未作答/)
    } finally { app.dispose(); await rm(dir, { recursive: true, force: true }) }
  })

  test(`${renderer}: keyboard answer archives only its request in the actual history`, async () => {
    const { app, stdin } = await makeApp({ renderer })
    const agent = { cwd: '/unused' } as AgentLoop
    try {
      await (app as any).frontend.ready
      attachDecisionSession(app, () => agent)
      let answer = ''
      let requestId: string | undefined
      const submit = app.submitDecisionText.bind(app)
      app.submitDecisionText = (text, id) => { requestId = id; return submit(text, id) }
      app.onSubmit(text => { answer = text })
      await ask(app, agent, 'first', '第一条问题')
      await ask(app, agent, 'second', '第二条问题')
      stdin.dataHandler!('2'); stdin.dataHandler!('\r')
      await tick()
      assert.equal(answer, '范围 B')
      assert.equal(requestId, 'first', '实际提交入口收到对应请求 ID')
      assert.equal(app.decisions.question?.id, 'second')
      const records = await (app as any).frontend.history.page(0)
      const cards = records.filter((r: { name?: string }) => r.name === 'ask_user_question')
      assert.deepEqual(cards.map((r: { toolId: string }) => r.toolId), ['first'])
      assert.match(cards[0].text, /已提交回答/)
      // 「已提交回答」的归档绑定投递成功（handleInputSubmit 在 onSubmitCallback 返回后
      // 补归），因此卡落在用户气泡**之后**——投递失败时历史里不会留下假的 answered 卡。
      const index = records.findIndex((r: { toolId?: string }) => r.toolId === 'first')
      assert.equal(records[index - 1].kind, 'user')
      assert.equal(records[index - 1].text, '范围 B')
      assert.doesNotMatch(stripAnsi((app as any).commit.getContent()), /第二条问题/)
    } finally { app.dispose() }
  })

  test(`${renderer}: discussing the current question leaves queued questions unarchived`, async () => {
    const { app } = await makeApp({ renderer })
    const agent = { cwd: '/unused' } as AgentLoop
    try {
      await (app as any).frontend.ready
      attachDecisionSession(app, () => agent)
      app.onSubmit(() => {})
      await ask(app, agent, 'first', '当前问题')
      await ask(app, agent, 'second', '排队问题')
      app.decisions.collapse()
      app.submitText('先讨论一下取舍')
      await tick()
      const cards = (await (app as any).frontend.history.page(0)).filter((r: { name?: string }) => r.name === 'ask_user_question')
      assert.deepEqual(cards.map((r: { toolId: string }) => r.toolId), ['first'])
      assert.match(cards[0].text, /转入讨论/)
      assert.doesNotMatch(cards[0].text, /已提交回答/)
    } finally { app.dispose() }
  })

  test(`${renderer}: failed answer delivery and retry never duplicate or archive queued cards`, async () => {
    const { app } = await makeApp({ renderer })
    const agent = { cwd: '/unused' } as AgentLoop
    try {
      attachDecisionSession(app, () => agent)
      let attempts = 0
      app.onSubmit(async () => { if (++attempts === 1) throw new Error('暂时不可发送') })
      await ask(app, agent, 'first', '待重试问题')
      await ask(app, agent, 'second', '尚未回答的问题')
      app.decisions.chooseQuestion('1')
      await app.decisions.submitAnswers()
      assert.match(app.decisions.question!.error!, /暂时不可发送/)
      assert.equal(app.decisions.question?.id, 'first')
      // 投递失败：提问仍是挂起态——历史里不得留下一张从未送达却标记已回答的卡。
      const midway = (await (app as any).frontend.history.page(0)).filter((r: { name?: string }) => r.name === 'ask_user_question')
      assert.deepEqual(midway.map((r: { toolId: string }) => r.toolId), [], '投递失败不得归档 answered 卡')
      await app.decisions.submitAnswers()
      assert.equal(attempts, 2)
      assert.equal(app.decisions.question?.id, 'second')
      const cards = (await (app as any).frontend.history.page(0)).filter((r: { name?: string }) => r.name === 'ask_user_question')
      assert.deepEqual(cards.map((r: { toolId: string }) => r.toolId), ['first'])
      assert.match(cards[0].text, /已提交回答/)
    } finally { app.dispose() }
  })

  test(`${renderer}: question errors remain ordinary errors in scrollback and history`, async () => {
    const { app } = await makeApp({ renderer })
    try {
      await (app as any).frontend.ready
      app.callbacks.onToolResult('invalid', 'ask_user_question', '错误：question 必填', true)
      await tick()
      const records = await (app as any).frontend.history.page(0)
      const error = records.find((r: { toolId?: string }) => r.toolId === 'invalid')
      assert.equal(error.isError, true)
      assert.match(error.text, /错误：question 必填/)
      assert.doesNotMatch(error.text, /需要你的回答/)
      assert.doesNotMatch(stripAnsi((app as any).commit.getContent()), /需要你的回答/)
    } finally { app.dispose() }
  })
}

test('archiving uses the terminal width at settlement rather than when the question arrived', async () => {
  const { app, out } = await makeApp()
  const agent = { cwd: '/unused' } as AgentLoop
  try {
    attachDecisionSession(app, () => agent)
    app.onSubmit(() => {})
    const prompt = '缩窄后必须保留所有问题内容'.repeat(6)
    await ask(app, agent, 'resize', prompt)
    out.columns = 35; (app as any).rerender()
    app.decisions.chooseQuestion('0')
    await app.decisions.submitAnswers()
    const card = (await (app as any).frontend.history.page(0)).find((r: { toolId?: string }) => r.toolId === 'resize')
    const lines = card.text.split('\n') as string[]
    assert.ok(lines.every(line => displayWidth(line) <= 35))
    const body = lines.slice(3, -1).map(line => line.slice(2, -2).trimEnd()).join('')
    assert.ok(body.includes(prompt), '问题原文完整保留')
  } finally { app.dispose() }
})

test('session switch archives unanswered questions in the old history only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-switch-'))
  const { app } = await makeApp()
  try {
    const oldPath = join(dir, 'old.jsonl'), newPath = join(dir, 'new.jsonl')
    await app.setUIHistorySession(oldPath)
    const agent = { cwd: dir } as AgentLoop
    attachDecisionSession(app, () => agent)
    await ask(app, agent, 'old', '旧会话问题')
    await app.setUIHistorySession(newPath)
    const cards = (await (await UIHistory.open(oldPath)).page(0)).filter(r => r.name === 'ask_user_question')
    assert.equal(cards.length, 1)
    assert.match(cards[0]!.text, /未作答/)
    assert.equal((await UIHistory.open(newPath)).count, 0)
    assert.equal(app.decisions.count, 0)
  } finally { app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('/cd (setCwd) archives pending questions before clearing the panel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-cwd-'))
  const { app } = await makeApp()
  try {
    const path = join(dir, 'history.jsonl')
    await app.setUIHistorySession(path)
    const agent = { cwd: dir } as AgentLoop
    attachDecisionSession(app, () => agent)
    await ask(app, agent, 'cwd', '切目录前的问题')
    assert.equal(app.decisions.count, 1, '面板持有该提问')
    app.setCwd(join(dir, 'other'))
    assert.equal(app.decisions.count, 0, '/cd 清面板')
    const cards = (await (await UIHistory.open(path)).page(0)).filter(r => r.name === 'ask_user_question')
    assert.equal(cards.length, 1, '提问必须随 /cd 归档，不得挂到退出才出现')
    assert.match(cards[0]!.text, /切目录前的问题/)
    assert.match(cards[0]!.text, /未作答/)
  } finally { app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('abort between question request and panel delivery archives the card unanswered instead of losing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-abort-'))
  const { app } = await makeApp()
  try {
    const path = join(dir, 'history.jsonl')
    await app.setUIHistorySession(path)
    const agent = { cwd: dir } as AgentLoop
    attachDecisionSession(app, () => agent)
    // 与生产同序：工具执行期间面板投递被 setImmediate 延迟，Esc 在面板起来前
    // 改了 runGen——世代守卫丢弃投递，但卡已被 handleToolResult 挂起。
    const result = await ASK_USER_QUESTION_TOOL.execute({ cwd: dir, toolUseId: 'abort-q',
      input: { question: '中断前的问题', options: [
        { label: '范围 A', recommended: true, recommendation_reason: '符合当前目标' }, { label: '范围 B' },
      ] },
      onAskUserQuestion: info => agent.onAskUserQuestionRequested?.(info) })
    assert.equal(result.isError, undefined, `工具必须接受该提问，got: ${result.content}`)
    ;(app as any).handleAbort()
    app.callbacks.onToolResult('abort-q', 'ask_user_question', result.content, false, undefined, result.uiContent)
    await tick()
    assert.equal(app.decisions.question, undefined, '世代守卫丢弃了面板投递')
    const cards = (await (await UIHistory.open(path)).page(0)).filter(r => r.name === 'ask_user_question')
    assert.equal(cards.length, 1, '提问不得随面板一起丢失、挂到退出才出现')
    assert.match(cards[0]!.text, /中断前的问题/)
    assert.match(cards[0]!.text, /未作答/)
  } finally { app.dispose(); await rm(dir, { recursive: true, force: true }) }
})
