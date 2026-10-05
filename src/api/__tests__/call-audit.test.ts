import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { beginCallAudit, readCallAudit } from '../call-audit.js'
import { OpenAIClient } from '../openai-client.js'
import { probeProvider } from '../provider-probe.js'
import { fetchWithTimeout } from '../fetch-timeout.js'
import { buildConfigRoutes } from '../../server/config-routes.js'

const home = mkdtempSync(join(tmpdir(), 'call-audit-test-'))
process.env.RIVET_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

it('actual wire, independent probe and non-chat transport have one completed audit each', async () => {
  let completions = 0
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'flash' }, { id: 'pro' }] })); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      completions++
      const model = JSON.parse(body).model
      response.setHeader('content-type', 'text/event-stream')
      response.end(`data: ${JSON.stringify({ id: `response-${completions}`, model: `${model}-actual`, system_fingerprint: 'server-fp', choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  try {
    const client = new OpenAIClient({ baseUrl, apiKey: 'test-placeholder', providerName: 'mock-provider', model: 'flash', maxTokens: 64, sessionId: 'audit-session', maxRetries: 0 })
    await client.stream({ model: 'flash', messages: [{ role: 'user', content: 'private prompt marker' }], stream: true }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: error => { throw error } })
    const main = readCallAudit({ sessionId: 'audit-session' })
    assert.equal(main.length, 1); assert.equal(main[0]?.phase, 'finished'); assert.equal(main[0]?.model, 'flash')
    assert.equal(main[0]?.responseModel, 'flash-actual'); assert.equal(main[0]?.usageKnown, true)
    const report = await probeProvider({ baseUrl, apiKey: 'test-placeholder', providerName: 'mock-provider', probeModel: 'pro', vision: false })
    assert.equal(report.completionOk, true)
    const probe = readCallAudit({ purpose: 'provider_probe' })
    assert.equal(probe.length, 1); assert.equal(probe[0]?.requestId, report.operationId)
    assert.equal(probe[0]?.model, 'pro'); assert.equal(probe[0]?.responseId, 'response-2')
    assert.equal(probe[0]?.usage?.prompt_tokens, 20); assert.equal(probe[0]?.sessionId, undefined)
    const native = await fetchWithTimeout(`${baseUrl}/responses`, { method: 'POST', body: JSON.stringify({ model: 'native' }) })
    assert.match(await native.text(), /hello/)
    assert.equal(readCallAudit({ model: 'native' })[0]?.usageKnown, true)
    const routes = buildConfigRoutes('test-auth')
    const denied = await routes['GET /config/provider-calls']!({}, { model: 'pro' }, {})
    assert.equal(denied.status, 401)
    const allowed = await routes['GET /config/provider-calls']!({}, { model: 'pro' }, { authorization: 'Bearer test-auth' })
    assert.equal(allowed.status, 200); assert.equal((allowed.body as { calls: unknown[] }).calls.length, 1)
    const raw = readFileSync(join(home, 'logs', 'provider-calls.jsonl'), 'utf8')
    assert.doesNotMatch(raw, /private prompt marker|test-placeholder|Bearer/)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
it('finish is idempotent and absent usage remains unknown', () => {
  const audit = beginCallAudit({ model: 'unknown-usage', purpose: 'provider_probe' })
  audit.finish({ status: 'failed', errorName: 'NetworkError' }); audit.finish({ status: 'complete', usage: { input_tokens: 100 } })
  const rows = readCallAudit({ model: 'unknown-usage' })
  assert.equal(rows.length, 1); assert.equal(rows[0]?.usageKnown, false); assert.equal(rows[0]?.status, 'failed')
})

it('retry attempts share a request identity and missing usage is never manufactured', async () => {
  let calls = 0
  const server = createServer((_request, response) => {
    if (++calls === 1) { response.writeHead(503); response.end('unavailable'); return }
    response.setHeader('content-type', 'text/event-stream')
    response.end('data: {"id":"retry-result","model":"flash","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  try {
    const client = new OpenAIClient({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'flash', maxTokens: 64, apiKey: '', maxRetries: 1, sessionId: 'audit-retry' })
    await client.stream({ model: 'flash', messages: [{ role: 'user', content: 'test' }], diagnostics: { purpose: 'worker_execution', workOrderId: 'mock-order', routeReason: 'explicit' } }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError: error => { throw error } })
    const rows = readCallAudit({ sessionId: 'audit-retry' })
    assert.equal(rows.length, 2); assert.equal(rows[0]?.requestId, rows[1]?.requestId)
    assert.notEqual(rows[0]?.operationId, rows[1]?.operationId)
    assert.equal(rows.filter(row => row.status === 'failed').length, 1)
    assert.equal(rows.filter(row => row.status === 'complete').length, 1)
    assert.ok(rows.every(row => row.usageKnown === false && row.workOrderId === 'mock-order' && row.routeReason === 'explicit'))
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
