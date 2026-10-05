/**
 * 活动期定高视口测试（TUI 输入框钉底）。
 *
 * 契约：
 *  1. padDynamicRegion 把动态段垫高/截断到恰好 budget display rows：
 *     - 不足 → 在动态内容与 chrome 之间垫空行（内容贴上、输入框贴下）；
 *     - 超出 → 从顶部截最旧行（approval 等关键内容在动态段尾部，天然保留）；
 *     - budget<=0 → 原样返回（空闲塌回）。
 *  2. TuiApp 活动期（thinking/streaming）连续帧的 live region 总 display rows
 *     恒定 —— 输入框屏幕坐标不随字符增长浮动。
 *  3. 活动期合并绘制；空闲与菜单关闭允许回缩，不跨轮预留空白。
 *  4. 小终端（rows=10）预算收缩，live region 不超屏。
 *  5. liveMaxRowsFor 终端高度感知（min(28, rows-1)，下限 4）。
 *  6. 普通区域最多半屏，审批与菜单可临时扩容。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padDynamicRegion, type LiveRegionLine } from '../live-engine.js'
import { liveMaxRowsFor } from '../app.js'
import { makeApp, stripAnsi } from './_harness.js'

const L = (...texts: string[]): LiveRegionLine[] => texts.map(text => ({ text }))

// ── padDynamicRegion 纯函数 ─────────────────────────────────────

test('不足预算：动态内容与 chrome 之间垫空行到恰好 budget，chromeStart 相应后移', () => {
  const lines = [...L('spinner', 'thinking'), ...L('input-top', 'input', 'input-bot')]
  const r = padDynamicRegion(lines, 2, 6)
  assert.equal(r.chromeStart, 6, 'chromeStart = 2 dynamic + 4 padding')
  assert.equal(r.lines.length, 9, '6 dynamic rows + 3 chrome')
  assert.deepEqual(r.lines.slice(0, 2).map(l => l.text), ['spinner', 'thinking'], '动态内容贴上')
  assert.ok(r.lines.slice(2, 6).every(l => l.text === ''), '空行垫在内容与 chrome 之间')
  assert.deepEqual(r.lines.slice(6).map(l => l.text), ['input-top', 'input', 'input-bot'], 'chrome 不动')
})

test('超出预算：从顶部截最旧行，动态段尾部（approval）保留', () => {
  const dynamic = L('old-1', 'old-2', 'old-3', 'old-4', 'approval-prompt')
  const chrome = L('input')
  const r = padDynamicRegion([...dynamic, ...chrome], 5, 3)
  assert.equal(r.chromeStart, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['old-3', 'old-4', 'approval-prompt', 'input'])
})

test('恰好等于预算：原样保留，无垫行无截断', () => {
  const lines = [...L('a', 'b', 'c'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', 'c', 'input'])
  assert.equal(r.chromeStart, 3)
})

test('budget<=0：原样返回（空闲塌回自然流）', () => {
  const lines = [...L('a'), ...L('input')]
  const r = padDynamicRegion(lines, 1, 0)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'input'])
  assert.equal(r.chromeStart, 1)
})

test('动态段为空：全部垫空行到 budget', () => {
  const r = padDynamicRegion(L('input'), 0, 4)
  assert.equal(r.chromeStart, 4)
  assert.ok(r.lines.slice(0, 4).every(l => l.text === ''))
  assert.equal(r.lines[4]!.text, 'input')
})

test('多 display-row 行按 measure 计数；整行丢弃低于预算后垫空行补齐到恰好 budget', () => {
  // wide 行占 3 display rows。budget=4：丢弃 wide(3) 后剩 a+b=2 rows < 4 → 垫 2 空行。
  const measure = (text: string): number => (text === 'wide' ? 3 : 1)
  const lines = [...L('wide', 'a', 'b'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 4, measure)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', '', '', 'input'])
  assert.equal(r.chromeStart, 4)
  const total = r.lines.slice(0, r.chromeStart).reduce((s, l) => s + measure(l.text), 0)
  assert.equal(total, 4, '动态段恒等于 budget display rows')
})

// ── liveMaxRowsFor ──────────────────────────────────────────────

test('liveMaxRowsFor：高终端封顶 28，小终端 rows-1，下限 4，非法值回退', () => {
  assert.equal(liveMaxRowsFor(50), 28)
  assert.equal(liveMaxRowsFor(29), 28)
  assert.equal(liveMaxRowsFor(20), 19)
  assert.equal(liveMaxRowsFor(10), 9)
  assert.equal(liveMaxRowsFor(4), 4)
  assert.equal(liveMaxRowsFor(2), 4, '下限 4：宁可超行不裁输入框')
  assert.equal(liveMaxRowsFor(0), 23, 'rows 缺失回退 24-1')
})

// ── TuiApp 集成：帧高度稳定性 ───────────────────────────────────

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const liveRows = (app: unknown): number => (app as { live: { lastDisplayRows: number } }).live.lastDisplayRows

/**
 * 轮内不缩（非「逐帧恒定」）：动态段按本轮高水位定高，内容增长时抬高、
 * 永不回缩。回缩才是输入框上抖的成因；单向抬高在满屏后由终端滚动吸收。
 */
const assertNoShrink = (heights: readonly number[]): void => {
  for (let i = 1; i < heights.length; i++) {
    assert.ok(
      heights[i]! >= heights[i - 1]!,
      `第 ${i} 帧回缩（输入框上抖）: ${heights[i]} < ${heights[i - 1]}（heights=${heights.join(',')}）`,
    )
  }
}

test('thinking 逐字增长期间 live region 轮内只涨不缩（输入框不上抖）', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const heights: number[] = []
  for (let i = 0; i < 12; i++) {
    app.callbacks.onThinkingDelta(`推理片段 ${i}：分析代码结构与依赖关系。\n`)
    await flush()
    heights.push(liveRows(app))
  }
  assert.ok(heights[0]! > 5, `活动期视口应有可观高度: ${heights[0]}`)
  assertNoShrink(heights)
  // 高水位跟随真实内容，不再恒定撑到引擎上限 liveMaxRowsFor(40)=28——撑到上限
  // 会让轮末塌回落差达 20+ 行，短回复后全部露成输入框下方的空白。
  assert.ok(
    heights[heights.length - 1]! < 28,
    `动态段不应撑到引擎上限: ${heights[heights.length - 1]}（heights=${heights.join(',')}）`,
  )
})

test('streaming 文本增长期间同样只涨不缩', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const heights: number[] = []
  for (let i = 0; i < 10; i++) {
    app.callbacks.onTextDelta(`streaming output chunk ${i} with some longer content to fill the tail. `)
    await flush()
    heights.push(liveRows(app))
  }
  assert.ok(heights[0]! > 5)
  assertNoShrink(heights)
  assert.ok(heights[heights.length - 1]! < 28, `heights=${heights.join(',')}`)
})

test('turn 结束后移除空白预留，只留下输入 chrome', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  app.callbacks.onThinkingDelta('思考中……\n')
  await flush()
  const active = liveRows(app)

  await (app as unknown as { handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void> })
    .handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await flush()
  const idle = liveRows(app)

  // 空闲期不再为旧动态帧保留空白。
  assert.ok(idle < active, `轮末应回缩: idle=${idle} active=${active}`)
})

test('连续多轮只在活动期扩容，空闲高度保持一致', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const priv = app as unknown as {
    setPhase: (p: string) => void
    renderLive: () => void
    agentBusy: boolean
    handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void>
  }
  const heights: number[] = []

  for (let turn = 1; turn <= 3; turn++) {
    // 轮开局：用户提交 → 进入活动期
    priv.agentBusy = true
    priv.setPhase('thinking')
    priv.renderLive()
    await flush()
    heights.push(liveRows(app))

    for (let i = 0; i < 5; i++) {
      app.callbacks.onThinkingDelta(`推理片段 ${i}\n`)
      await flush()
    }
    app.callbacks.onTextDelta('简短回复。')
    await flush()
    heights.push(liveRows(app))

    await priv.handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, turn, true)
    await flush()
    heights.push(liveRows(app))
  }

  const idle = heights.filter((_, i) => i % 3 === 2)
  assert.ok(idle.every(height => height === idle[0]), `idle=${idle}`)
  assert.ok(heights.every(height => height <= 20), `heights=${heights}`)
})

test('首帧走自然流，不补空行撑底（凭空造的空白只能堆在欢迎屏某一侧，比自然流更难看）', async () => {
  const { out } = makeApp({ cols: 80, rows: 40 })
  await flush()
  assert.equal(out.chunks.find(c => /^\n{2,}$/.test(c)), undefined,
    `首帧不应出现成片空行: ${JSON.stringify(out.chunks.slice(0, 4))}`)
})

test('小终端（rows=10）预算收缩，live region 不超屏', async () => {
  const { app } = makeApp({ cols: 80, rows: 10 })
  for (let i = 0; i < 8; i++) {
    app.callbacks.onThinkingDelta(`小屏思考片段 ${i}\n`)
    await flush()
    assert.ok(liveRows(app) <= 10, `live region 超屏: ${liveRows(app)} > 10`)
  }
})

test('30 行窗口：高水位压到半屏（cap=15）——峰值预留不吃掉半屏以上', async () => {
  const { app } = makeApp({ cols: 80, rows: 30 })
  const priv = app as unknown as {
    getDynamicBudget: (chromeRows: number, dynamicRows: number) => number
    renderLive: () => void
    setPhase: (p: string) => void
    agentBusy: boolean
  }
  priv.agentBusy = true
  priv.setPhase('thinking')
  // 一轮大峰值：动态 20 + chrome 6 = 26 > cap 15 → 压到 15，预算 = 15 − 6 = 9
  assert.equal(priv.getDynamicBudget(6, 20), 9)
  // 高水位被 cap 钳住：后续小内容不会突破 15
  assert.equal(priv.getDynamicBudget(6, 2), 9)
  priv.renderLive()
  await flush()
  assert.equal(liveRows(app), 15, `30 行窗口 live region 应恰好等于半屏 cap: ${liveRows(app)}`)
})

test('32 行窗口同样限制普通高水位为半屏', () => {
  const { app } = makeApp({ cols: 80, rows: 32 })
  const priv = app as unknown as {
    getDynamicBudget: (chromeRows: number, dynamicRows: number) => number
    setPhase: (p: string) => void
    agentBusy: boolean
  }
  priv.agentBusy = true
  priv.setPhase('thinking')
  assert.equal(priv.getDynamicBudget(6, 20), 10)
})

test('半屏 cap 不截掉审批状态行：rows=30 审批挂起时「等待审批」仍可见', async () => {
  const { app, out } = makeApp({ cols: 80, rows: 30 })
  void app.callbacks.onApprovalRequired!('1', 'read_file', { file_path: '/tmp/x' })
  await flush()
  const frame = stripAnsi(out.chunks.join(''))
  assert.ok(frame.includes('等待审批 read_file'), '半屏 cap 下审批状态行不得被截掉')
})

test('欢迎页 slash 关闭后释放菜单预留', async () => {
  const { app } = makeApp({ cols: 80, rows: 24 })
  app.setSlashCommands(
    Array.from({ length: 8 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `desc ${i}`,
      tier: 'core' as const,
    })),
  )
  await flush()
  const idle = liveRows(app)
  assert.ok(idle > 0, `欢迎首帧应已画出 live region: ${idle}`)

  app.setInput('/')
  await flush()
  const open = liveRows(app)
  assert.ok(open > idle, `slash 打开应撑高（输入框下落）: open=${open} idle=${idle}`)

  app.setInput('')
  await flush()
  const closed = liveRows(app)
  assert.ok(
    closed < open,
    `欢迎页取消 slash 后应释放预留: closed=${closed} open=${open} idle=${idle}`,
  )
})

test('活动期 slash 关闭后回落半屏预算', async () => {
  const { app } = makeApp({ cols: 80, rows: 24 })
  app.setSlashCommands(
    Array.from({ length: 8 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `desc ${i}`,
      tier: 'core' as const,
    })),
  )
  app.callbacks.onThinkingDelta('思考中\n')
  await flush()
  const before = liveRows(app)

  app.setInput('/')
  await flush()
  const open = liveRows(app)
  assert.ok(open > before, `slash 提示应撑高 chrome: open=${open} before=${before}`)

  app.setInput('')
  await flush()
  const closed = liveRows(app)
  // 关闭态回落到半屏预算内（菜单扩容的预留不得滞留）。chrome 轻量时菜单把动态段
  // 挤到 0，open 本身即半屏下界——故"回落"以半屏为界，而非严格小于 open。
  assert.ok(
    closed <= Math.ceil(24 / 2),
    `slash 关闭后应回落到半屏预算内: closed=${closed} open=${open} before=${before}`,
  )
})
