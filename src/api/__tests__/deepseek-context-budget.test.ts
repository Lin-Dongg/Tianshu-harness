import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { enforceRequestBodyLimit } from '../request-body-guard.js'
import { classifyApiError } from '../error-classifier.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { OaiMessage } from '../oai-types.js'

const config = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'test-placeholder', maxTokens: 384_000, thinking: 'enabled' as const, maxRetries: 0 }
const callbacks = { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: (e: Error) => { throw e } }
test('final transport guard rejects an oversized request before fetch', async t => {
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('network forbidden') })
  await assert.rejects(new OpenAIClient(config).stream({ model: config.model, stream: true, messages: [{ role: 'user', content: 'x'.repeat(4_000_000) }] }, callbacks), { name: 'ContextBudgetExceededError' })
  assert.equal(fetched, false)
})

test('actual outgoing body keeps non-tool-turn reasoning when request has tools', async t => {
  let sent: any
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sent = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  await new OpenAIClient(config).stream({ model: config.model, stream: true,
    messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'answer', reasoning_content: 'RETAIN_FULL_REASONING' }, { role: 'user', content: 'next' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'empty', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'empty', content: 'result' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: {} } }],
  }, callbacks)
  assert.equal(sent.messages[1].reasoning_content, 'RETAIN_FULL_REASONING')
  assert.equal(sent.messages[3].reasoning_content, '')
})

test('official prompt assembly does not strip aged reasoning at the collapse watermark', () => {
  const engine = new PromptEngine({ ...config, requestBudgetPolicy: { windowTokens: 1_048_576, maxOutputTokens: 393_216 }, staticCtx: { tools: [] }, volatileCtx: { cwd: '/tmp', gitStatus: '', rivetMd: '' } })
  const messages: OaiMessage[] = []
  for (let i = 0; i < 12; i++) messages.push({ role: 'user', content: `question ${i}` }, { role: 'assistant', content: 'answer', reasoning_content: `REASON_${i}` })
  messages.push({ role: 'user', content: 'x'.repeat(2_500_000) })
  const req = engine.buildOaiRequest(messages, undefined, 1_048_576)
  assert.equal((req.messages.find(m => m.role === 'assistant') as any).reasoning_content, 'REASON_0')
})

test('byte overflows neither discard images nor masquerade as context tokens', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x'.repeat(4096) } }] }] }
  const before = JSON.stringify(body)
  assert.throws(() => enforceRequestBodyLimit(body, { limitBytes: 1024, preserveContent: true }), { name: 'RequestBodyTooLargeError' })
  assert.equal(JSON.stringify(body), before)
  const tooLarge = new Error('请求体 4.6MB 超出传输上限 4.0MB')
  tooLarge.name = 'RequestBodyTooLargeError'
  assert.equal(classifyApiError(tooLarge).category, 'request_body_too_large', '字节超限不得伪装成 context token 问题')
})

test('ordinary tool continuation keeps the outgoing prefix byte-for-byte identical', async t => {
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const client = new OpenAIClient(config)
  const messages: OaiMessage[] = [{ role: 'system', content: 'frozen' }, { role: 'user', content: 'task' },
    { role: 'assistant', content: 'answer', reasoning_content: 'FULL_ORIGINAL_REASONING' }]
  const tools = [{ type: 'function' as const, function: { name: 'read', description: 'read', parameters: {} } }]
  await client.stream({ model: config.model, stream: true, messages, tools }, callbacks)
  await client.stream({ model: config.model, stream: true, messages: [...messages,
    { role: 'user', content: '<system-reminder>new progress</system-reminder>' }], tools }, callbacks)
  assert.equal(JSON.stringify(bodies[1].messages.slice(0, 3)), JSON.stringify(bodies[0].messages))
  assert.deepEqual(bodies[0].tools, bodies[1].tools)
  // 官方 DeepSeek 单次输出封顶到现实预留（config.maxTokens=384K 被 cap 到 256_000）
  assert.equal(bodies[1].max_tokens, 256_000)
  assert.equal('contextBudget' in bodies[1], false)
})

for (const images of [false, true]) {
  test(`official 413 is a byte rejection, no silent image retry (images=${images})`, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('payload too large', { status: 413 }) })
    let caught: unknown
    try {
      await new OpenAIClient(config).stream({ model: config.model, stream: true, messages: [{ role: 'user', content: images
        ? [{ type: 'text', text: 'task' }, { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] : 'task' }] }, callbacks)
    } catch (error) { caught = error }
    assert.equal(classifyApiError(caught).category, 'request_body_too_large')
    assert.equal(calls, 1)
  })
}

test('preflight uses the model-visible request so ignored reasoning does not trigger a cache rewrite', async () => {
  const { prepareContextRequest } = await import('../../agent/context-budget-preparation.js')
  const client = new OpenAIClient(config)
  const request = { model: config.model, max_tokens: 384_000, messages: [
    { role: 'user' as const, content: 'question' }, { role: 'assistant' as const, content: 'answer', reasoning_content: 'r'.repeat(2_600_000) },
    { role: 'user' as const, content: 'follow up' },
  ] }
  let compacts = 0
  const prepared = await prepareContextRequest({ build: () => request, policy: { windowTokens: 1_000_000, maxOutputTokens: 393_216 },
    preview: r => client.previewContextRequest(r), compact: async () => { compacts++; return false }, publish: () => {} }).catch(error => { assert.fail(`ignored reasoning must not cause a preflight rejection: ${error.message}`) })
  assert.equal(compacts, 0)
  assert.equal(prepared.contextBudget?.reasoningTokens, 0)
  assert.equal(request.messages[1]?.reasoning_content?.length, 2_600_000, 'preview must not edit stored reasoning')
})
