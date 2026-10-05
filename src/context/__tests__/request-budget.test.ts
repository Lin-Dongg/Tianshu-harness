import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextBudget, deepSeekBudgetPolicy, DEEPSEEK_WINDOW, estimateBudgetInput } from '../request-budget.js'
import { estimateOaiMessageTokens } from '../../compact/micro.js'

test('multimodal CJK uses the same text accounting as plain text', () => {
  const text = '中'.repeat(120_000)
  const plain = estimateOaiMessageTokens({ role: 'user', content: text })
  assert.equal(estimateOaiMessageTokens({ role: 'user', content: [{ type: 'text', text }] }), plain)
  assert.ok(estimateOaiMessageTokens({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.jpg' } }] }) > plain)
})

test('outputReserve 用现实预留而非能力上限：60% window 不再超预算（回归 566K 死锁）', () => {
  const policy = deepSeekBudgetPolicy('https://api.deepseek.com/v1', 'deepseek-flash')!
  // max_tokens 传能力上限 384K——旧行为把它当 outputReserve，inputBudget 仅 612_147、
  // 60% window 就 blocked；现封顶到 DEEPSEEK_OUTPUT_RESERVE=256_000。
  const budget = buildContextBudget({ model: 'deepseek-flash', max_tokens: 384_000, messages: [{ role: 'user', content: 'x'.repeat(Math.ceil(DEEPSEEK_WINDOW * 0.6) * 4) }] }, policy, { requestId: 'test', revision: 1 })
  assert.equal(budget.outputReserve, 256_000)
  assert.equal(budget.inputBudget, 740_147) // 1_048_576 − 256_000 − 52_429
  assert.notEqual(budget.state, 'blocked', '60% window 应在输入预算内——不再被能力上限堵死')
})

test('outputReserve 只封顶、不放大：显式的小 max_tokens 原样保留', () => {
  const policy = deepSeekBudgetPolicy('https://api.deepseek.com/v1', 'deepseek-flash')!
  const budget = buildContextBudget({ model: 'deepseek-flash', max_tokens: 4_096, messages: [] }, policy, { requestId: 't', revision: 1 })
  assert.equal(budget.outputReserve, 4_096)
})

test('unknown relays do not inherit official budgets and smaller configured windows survive', () => {
  assert.equal(deepSeekBudgetPolicy('https://relay.example/v1', 'deepseek-flash'), undefined)
  assert.equal(deepSeekBudgetPolicy('https://api.deepseek.com', 'unknown-model'), undefined)
  assert.equal(deepSeekBudgetPolicy('https://api.deepseek.com', 'deepseek-flash', 500_000)?.windowTokens, 500_000)
})

test('wire accounting includes tools, reasoning and native image budget exactly once', () => {
  const counts = estimateBudgetInput([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'a'.repeat(10_000) } }] },
    { role: 'assistant', content: 'done', reasoning_content: 'r'.repeat(4000) },
  ], [{ description: 't'.repeat(4000) }])
  assert.equal(counts.imageTokens, 1024)
  assert.equal(counts.reasoningTokens, 1000)
  assert.ok(counts.toolTokens >= 1000)
  assert.equal(counts.inputTokens, 1024 + 1001 + 16 + counts.toolTokens)
})

test('native image count and per-image bytes fail visibly without discarding input', async () => {
  const { deepSeekImageLimitError } = await import('../image-input-limits.js')
  const image = { type: 'image_url' as const, image_url: { url: 'https://example.com/picture.png' } }
  assert.equal(deepSeekImageLimitError([{ role: 'user', content: Array(600).fill(image) }]), undefined)
  assert.equal(deepSeekImageLimitError([{ role: 'user', content: Array(601).fill(image) }])?.name, 'ImageInputRejectedError')
  const huge = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(32 * 1024 * 1024 / 3) * 4 + 4) } }
  assert.equal(deepSeekImageLimitError([{ role: 'user', content: [huge] }])?.name, 'ImageInputRejectedError')
})
