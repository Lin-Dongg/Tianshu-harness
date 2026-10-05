/**
 * T9 GlanceBar 真实指标测试（B）。
 *
 * 契约（CC 对标 f9001b16：ctx% 并入 ◧token 常驻，cache ⚡ 仅 <50% 浮出）：
 *  1. 设置 metricsProvider 后，GlanceBar 用真实 ◧Xk/Yk·$cost·⚡% 渲染。
 *  2. 无 provider 时不猜价格：GlanceBar 明示暂无计价，不渲染费用金额
 *     （537ca8b0 起真实费用只来自 metricsProvider 的 findModelPricing +
 *     computeUsageCost；旧回退用硬编码定价且 += 累计快照，费用随回合膨胀）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 120
  rows = 24
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  // 默认 compact 档保留 ⚡/effort，收起 cost/token 绝对值/goal/todo；本套件验证
  // metrics 管线（provider → 渲染）需要全量展示，固定 full 档。
  app.glanceDensity = 'full'
  app.setSidePanelOpen(true)
  app.start()
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

test('metricsProvider 提供真实 ◧Xk/Yk·$cost·⚡%（cache 命中率常驻展示，按健康度着色）', () => {
  const { app, out } = makeApp()
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.3,
    cost: 1.23,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
  }))
  // setModelInfo 触发一次 renderLive
  app.setModelInfo('test', 200_000)
  const plain = stripAnsi(out.chunks.join(''))
  // estimatedTokens (50k) is the calibrated context occupancy; lastRealPromptTokens
  // is only used internally to compute the calibration ratio.
  assert.ok(plain.includes('50k / 200k'), `Xk/Yk: ${plain}`)
  assert.ok(plain.includes('1.23'), `cost: ${plain}`)
  assert.ok(plain.includes('cache 30%'), `cache 常驻展示: ${plain}`)
})

test('cache 健康态（≥50%）常驻展示为 dim 色，不再门控隐藏', () => {
  const { app, out } = makeApp()
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.6,
    cost: 1.23,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
  }))
  app.setModelInfo('test', 200_000)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('cache 60%'), `健康态也应常驻展示命中率: ${plain}`)
  assert.ok(plain.includes('50k / 200k'), `token 显示校准后的上下文占用: ${plain}`)
})

test('无 provider 回退：多次 onTurnComplete 后明示暂无计价且不渲染费用金额', async () => {
  const { app, out } = makeApp()
  // agent 每回合传入的是「累计」usage 快照。旧回退用硬编码定价估算，
  // 会把 1M input 渲染成费用并随回合膨胀；现契约是无 provider 时 cost 恒 0，
  // GlanceBar 明示暂无计价，不能把未知成本显示成估算 ¥0.00。
  const cumulative = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  app.callbacks.onTurnComplete(cumulative, 1, false)
  app.callbacks.onTurnComplete(cumulative, 2, false)
  app.callbacks.onTurnComplete(cumulative, 3, false)
  await tick(30)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('暂无计价'), `无 provider 应明示暂无计价: ${plain}`)
  assert.ok(!/¥\d/.test(plain), `无 provider 不应渲染任何费用: ${plain}`)
})

test('GlanceBar 显示可见对话 token（conversationTokens），颜色仍按真实 API 占用（estimatedTokens）', () => {
  const { app, out } = makeApp()
  app.setMetricsProvider(() => ({
    estimatedTokens: 95_000,   // real API-facing occupancy → high ratio
    conversationTokens: 47_000, // visible chat context → lower number
    maxTokens: 1_000_000,
    cacheHitRate: 0.99,
    cost: 0,
    inputTokens: 95_000,
    outputTokens: 2_000,
    lastRealPromptTokens: 95_000,
  }))
  app.setModelInfo('test', 1_000_000)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('95k / 1.0M'), `optional context panel shows the actual API-facing occupancy: ${plain}`)
  assert.equal(app.getMetrics()?.conversationTokens, 47_000, 'visible conversation token count remains available to consumers')
  // 95k/1M = 9.5% → muted color, not warning/error; ratio is based on estimatedTokens.
  // full 档状态行（GlanceBar 回归）展示可见对话 token；侧栏面板行 `95k / 1.0M`
  // 展示 API 口径占用——两者数据源不同，各司其职。
  assert.ok(plain.includes('◧47k/1.0M'), `full 档状态行展示可见对话 token: ${plain}`)
})

test('pricingPhase 接线：provider 给值时 GlanceBar 渲染计价段，缺省不渲染', () => {
  const { app, out } = makeApp()
  // deepseek 侧（main.ts metricsProvider 仅在 providerName==='deepseek' 时给值）
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.9,
    cost: 0,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
    pricingPhase: 'offpeak',
  }))
  app.setModelInfo('test', 200_000)
  const plain = stripAnsi(out.chunks.join(''))
  assert.equal(app.getMetrics()?.pricingPhase, 'offpeak', 'pricing phase remains available from the actual provider')
  assert.ok(plain.includes('◷闲时半价'), 'the local pricing reminder survives the frontend port')

  // 非 deepseek：metrics 无 pricingPhase → 计价段消失
  out.chunks.length = 0
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.9,
    cost: 0,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
  }))
  app.setModelInfo('test', 200_000)
  const plain2 = stripAnsi(out.chunks.join(''))
  assert.ok(!plain2.includes('◷'), `非 deepseek 不应渲染计价段: ${plain2}`)
})

test('getMetrics 暴露与 GlanceBar 同源的真实指标（供 SlashRouter 读 cost/maxTokens）', () => {
  const { app } = makeApp()
  // 无 provider 时为 null（SlashRouter 回退 models[0]/cost:0）
  assert.equal(app.getMetrics(), null, '无 provider 应返回 null')

  app.setMetricsProvider(() => ({
    estimatedTokens: 80_000,
    conversationTokens: 80_000,
    maxTokens: 200_000,
    cacheHitRate: 0.5,
    cost: 2.5,
    inputTokens: 80_000,
    outputTokens: 4_000,
    lastRealPromptTokens: 78_000,
  }))
  const m = app.getMetrics()
  assert.equal(m?.cost, 2.5, 'cost 应来自 provider，不再写死 0')
  assert.equal(m?.maxTokens, 200_000, 'maxTokens 应为当前模型窗口，不再取 models[0]')
})

test('CVM 拦截计数接线：metricsProvider 给值时 GlanceBar 常驻显示 `⛨ N`（issue #247 补充项）', () => {
  const { app, out } = makeApp()
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.9,
    cost: 0,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
    cvmInterceptions: 4,
  }))
  app.setModelInfo('test', 200_000)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('⛨ 4'), `metricsProvider → GlanceBar 应透传拦截计数: ${plain}`)
})

test('CVM 拦截计数 0 也占位；provider 缺省该字段则不占位', () => {
  const { app, out } = makeApp()
  // 0 = 本会话尚未触发拦截，仍须可见（否则与「能力不存在」不可区分）
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.9,
    cost: 0,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
    cvmInterceptions: 0,
  }))
  app.setModelInfo('test', 200_000)
  const withZero = stripAnsi(out.chunks.join(''))
  assert.ok(withZero.includes('⛨ 0'), `0 应占位: ${withZero}`)

  // RIVET_CVM_VECTOR=off / 非 CVM 宿主：provider 不给该字段 → 整段消失
  out.chunks.length = 0
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    conversationTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.9,
    cost: 0,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
  }))
  app.setModelInfo('test', 200_000)
  const without = stripAnsi(out.chunks.join(''))
  assert.ok(!without.includes('⛨'), `缺省该字段不应占位: ${without}`)
})
