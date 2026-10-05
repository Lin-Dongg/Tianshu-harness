import { it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { createReportClientFactory } from '../report-client.js'
import { resolveCapabilities } from '../provider.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { Usage } from '../types.js'
import { ContinuationPrefixError, assertContinuationPrefix, proveWirePrefix } from '../continuation-prefix.js'
import { classifyApiError } from '../error-classifier.js'

it('a known history fork stays non-retryable even when output options changed', () => {
  const prior = proveWirePrefix({ model: 'same', messages: [{ role: 'user', content: 'original' }], max_tokens: 100 }, 'same', 'prior')
  const next = proveWirePrefix({ model: 'same', messages: [{ role: 'user', content: 'changed' }], max_tokens: 200 }, 'same', 'next')
  assert.throws(() => assertContinuationPrefix(prior, next), error => {
    assert.ok(error instanceof ContinuationPrefixError)
    assert.equal(classifyApiError(error).retryable, false)
    assert.equal(error.previous.requestId, 'prior')
    return true
  })
})

it('final wire verifies continuation before fetch; side paths preserve main baseline; response metadata retained', async () => {
  const oldFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  const observations: Array<Partial<Usage>> = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: '+JSON.stringify({ id: 'server-1', system_fingerprint: 'fp-1', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const client = new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'deepseek-v4-flash', maxTokens: 16384, thinking: 'enabled', thinkingBlockType: 'enabled' })
    const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason(_r: string, u: Partial<Usage>) { observations.push(u) }, onError(e: Error) { throw e } }
    const request: OaiChatRequest = { model: 'deepseek-v4-flash', prefixProbe: true, messages: [{ role: 'system', content: '稳定' }, { role: 'user', content: '旧目标' }], tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }] }
    await client.stream(request, callbacks)
    const proof = JSON.parse(JSON.stringify(client.getMainPrefixProof()))
    assert.equal(observations[0]?.observation?.wire?.baseline, 'baseline_missing')
    await client.stream({ model: request.model, messages: [{ role: 'user', content: '侧路' }] }, callbacks)
    assert.deepEqual(client.getMainPrefixProof(), proof)
    const continued: OaiChatRequest = { ...request, messages: [...request.messages, { role: 'assistant', content: '观察', reasoning_content: '思考' }, { role: 'user', content: '只追加目标' }], diagnostics: { purpose: 'worker_execution', continuationSource: 'explicit_resume', priorPrefix: proof, previousMainRequestId: proof.requestId } }
    await client.stream(continued, callbacks)
    assert.deepEqual((bodies[2]!.messages as unknown[]).slice(0, 2), bodies[0]!.messages)
    assert.equal((bodies[2]!.messages as Array<Record<string, unknown>>)[2]!.reasoning_content, '思考')
    const observation = observations.at(-1)?.observation
    assert.equal(observation?.wire?.baseline, 'present')
    assert.equal(observation?.responseId, 'server-1')
    assert.equal(observation?.systemFingerprint, 'fp-1')
    assert.equal(observation?.finishReason, 'stop')
    assert.deepEqual(observation?.wire?.options.thinking, { type: 'enabled' })
    await assert.rejects(client.stream({ ...continued, messages: [{ role: 'system', content: '分叉' }, ...continued.messages.slice(1)] }, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 3, 'divergence fails before fetch')
  } finally { globalThis.fetch = oldFetch }
})

it('report factory disables thinking in actual wire without mutating execution client', async () => {
  const oldFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const provider = { unsupported: [], maxTokens: 16384, capabilities: {}, name: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'openai' as const, apiKeyEnv: 'UNUSED', thinking: 'enabled' as const, models: [{ id: 'deepseek-v4-flash', contextWindow: 1000000, maxTokens: 16384 }] }
    const capabilities = resolveCapabilities('deepseek')
    const execution = new OpenAIClient({ providerName: 'deepseek', baseUrl: provider.baseUrl, apiKey: 'test', model: 'deepseek-v4-flash', maxTokens: 16384, thinking: 'enabled', thinkingBlockType: 'enabled' })
    const report = createReportClientFactory(provider, capabilities, { apiKey: 'test', model: 'deepseek-v4-flash' })()
    const cb = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(e: Error) { throw e } }
    await report.stream({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'JSON' }], response_format: { type: 'json_object' }, diagnostics: { purpose: 'worker_report_repair' } }, cb)
    await execution.stream({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'execution' }] }, cb)
    assert.deepEqual(bodies[0]!.thinking, { type: 'disabled' })
    assert.deepEqual(bodies[0]!.response_format, { type: 'json_object' })
    assert.deepEqual(bodies[1]!.thinking, { type: 'enabled' })
  } finally { globalThis.fetch = oldFetch }
})
