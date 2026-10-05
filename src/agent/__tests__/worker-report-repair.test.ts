import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { StreamClient } from '../../api/stream-client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import { runWorkerSession, createSoftLandingDrain, type WorkerSessionConfig } from '../worker-session.js'
import { buildReportRepairPacket, REPORT_TOKEN_LIMIT, reportFailureKind } from '../worker-report-repair.js'

const packet = (id: string) => ({ workOrderId: id, status: 'passed', summary: '定位到接缝', findings: [{ claim: '原始发现', evidence: 'a.ts:1', confidence: 'high' }], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' })
function makeConfig(raw: string, repairRaw?: string, rejected = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-report-replay-'))
  const requests: OaiChatRequest[] = []
  const repairs: OaiChatRequest[] = []
  const order = createReadOnlyWorkOrder({ id: `replay-${cwd.split('-').at(-1)}`, parentTurnId: 't', kind: 'code_search', profile: 'code_scout', objective: '定位 a.ts 接缝', scope: {} , budget: { maxRetries: 9 } })
  const client: StreamClient = { async stream(req, cb) {
    requests.push(req)
    cb.onTextDelta(raw); cb.onContentBlock({ type: 'text', text: raw }); cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
  } }
  const config: WorkerSessionConfig = {
    order, cwd, client, toolRegistry: new ToolRegistry(),
    promptEngine: new PromptEngine({ model: 'test', maxTokens: 16384, staticCtx: { tools: [], audience: 'subagent' }, volatileCtx: { cwd } }),
    maxTurns: 2, contextWindow: 128000, compact: { enabled: false, model: 'flash' },
    ...(repairRaw !== undefined ? { reportRepairClient: { async stream(req, cb) {
      repairs.push(req)
      if (rejected) { cb.onError(new Error('response_format rejected')); return }
      cb.onTextDelta(repairRaw); cb.onContentBlock({ type: 'text', text: repairRaw }); cb.onStopReason('end_turn', { input_tokens: 20, output_tokens: 8 })
    } } as StreamClient } : {}),
  }
  return { config, requests, repairs }
}

for (const [name, raw, kind] of [
  ['DSML', '<｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command">touch UNAUTHORIZED</｜DSML｜parameter>', 'channel'],
  ['非报告', '已经查完，没有完整报告。', 'non_report'],
  ['缺字段', '{"summary":"定位到接缝","findings":[]}', 'schema'],
  ['截断', '{"workOrderId":"x","status":"passed","summary":"截断', 'truncated'],
] as const) {
  it(`${name}: one independent repair, no exploration re-entry or execution of text tools`, async () => {
    const { config, requests, repairs } = makeConfig(raw, JSON.stringify(packet('x')))
    const run = await runWorkerSession(config)
    assert.equal(requests.length, 2, 'one execution + one same-prefix closing')
    assert.equal(repairs.length, 1, 'maxRetries=9 still allows only one report repair')
    assert.equal(repairs[0]!.messages.length, 1, 'never send exploration history')
    assert.equal(repairs[0]!.tools, undefined)
    assert.equal(repairs[0]!.max_tokens, REPORT_TOKEN_LIMIT)
    assert.deepEqual(repairs[0]!.response_format, { type: 'json_object' })
    assert.equal(run.result.status, 'blocked', 'fragment repair cannot fabricate trustworthy passed')
    assert.equal(run.result.evidenceStatus, 'unverified')
    assert.equal(run.usage.input_tokens, 40, 'execution + closing + repair each charged once')
    assert.equal(run.transcript.repairAttempts, 1)
    assert.equal(run.transcript.reportDiagnostics?.[0]?.kind, kind)
    assert.equal(run.transcript.toolUses.length, 0, 'DSML text never executes tools')
    const artifact = run.transcript.reportDiagnostics?.[0]?.artifact
    assert.ok(artifact)
    assert.ok(readFileSync(artifact, 'utf8').includes(raw.replace(/"/g, '\\"')))
  })
}

it('mode rejection or invalid repair returns salvage without further requests', async () => {
  for (const rejected of [true, false]) {
    const { config, requests, repairs } = makeConfig('not a report', 'still not a report', rejected)
    const run = await runWorkerSession(config)
    assert.equal(requests.length, 2)
    assert.equal(repairs.length, 1)
    assert.equal(run.result.status, 'blocked')
  }
})

it('complete local report avoids closing and repair; short summary stays intact', async () => {
  const { config, requests, repairs } = makeConfig(JSON.stringify(packet('x')), 'unused')
  const run = await runWorkerSession(config)
  assert.equal(requests.length, 1)
  assert.equal(repairs.length, 0)
  assert.equal(run.result.summary, '定位到接缝')
})

it('whole-field admission bounds input and identifies omitted entries without slicing JSON', () => {
  const { config } = makeConfig('')
  const transcript = { text: '', thinking: '', toolUses: ['read_file'], toolResults: [], errors: ['巨大完整字段'.repeat(12000)], repairAttempts: 0, mutatedFiles: Array.from({ length: 10000 }, (_, i) => `whole-entry-${i}.ts`) }
  const repair = buildReportRepairPacket(config.order, '', transcript, { kind: 'syntax', error: 'bad' })!
  assert.ok(Buffer.byteLength(repair.prompt) <= REPORT_TOKEN_LIMIT)
  assert.ok(repair.omitted.length > 0)
  const data = JSON.parse(repair.prompt.slice(repair.prompt.indexOf('\n') + 1))
  assert.ok(data.capturedFiles.every((p: string) => /^whole-entry-\d+\.ts$/.test(p)))
  assert.equal(reportFailureKind('<｜DSML｜invoke>', new Error('missing schema')), 'channel')
})

it('soft landing requests submit_result, consistent with the first-turn contract', () => {
  const drain = createSoftLandingDrain(undefined, 'finalized')
  drain.requestWrapUp()
  assert.match(drain.drain()!, /submit_result/)
  assert.equal(drain.drain(), null)
})

it('actual continuation first request inherits wire history/system/tools and appends only the new goal', async () => {
  const { OpenAIClient } = await import('../../api/openai-client.js')
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const text = JSON.stringify(packet('x'))
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text, reasoning_content: '实际回传思考' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const { config } = makeConfig('unused')
    config.promptEngine = new PromptEngine({ model: 'deepseek-v4-flash', maxTokens: 16384, staticCtx: { tools: [], audience: 'subagent' }, volatileCtx: { cwd: config.cwd } })
    config.client = new OpenAIClient({ providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'deepseek-v4-flash', maxTokens: 16384, thinking: 'enabled', thinkingBlockType: 'enabled' })
    config.providerName = 'deepseek'
    const first = await runWorkerSession(config)
    const second = await runWorkerSession({ ...config, order: { ...config.order, objective: '只补查一个调用点' },
      priorMessages: first.session.getMessages(), priorFrozenSnapshot: first.frozenSnapshot, priorPrefixProof: first.prefixProof, continuationSource: 'explicit_resume' })
    assert.equal(bodies.length, 2)
    const a = bodies[0]!.messages as unknown[]
    const b = bodies[1]!.messages as Array<Record<string, unknown>>
    assert.deepEqual(b.slice(0, a.length), a)
    assert.deepEqual(bodies[1]!.tools, bodies[0]!.tools)
    assert.equal(b[2]!.reasoning_content, '实际回传思考')
    const deltaUser = [...second.session.getMessages()].reverse().find(m => m.role === 'user')
    assert.ok(!String(deltaUser?.content).includes('执行纪律（全星域共享）'), `do not rebuild the complete boot prompt: ${String(deltaUser?.content).slice(0, 300)}`)
    assert.match(String(b.at(-1)!.content), /只补查一个调用点/)
    assert.equal(second.prefixProof?.messages.length, b.length)
  } finally { globalThis.fetch = originalFetch }
})
