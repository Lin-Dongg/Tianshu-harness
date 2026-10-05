import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { compactBudgetHistory } from '../budget-compaction.js'
import { askSidePath } from '../side-path-ask.js'
import { describeImages, visionCacheKey } from '../vision-service.js'
import { tierToolResult, extractTrailingArtifactId } from '../tool-result-tiering.js'
import { workerResultFingerprint } from '../worker-result-reuse.js'
import { createReadOnlyWorkOrder, type WorkerResult } from '../work-order.js'
import { buildPrimaryWorkerPacket } from '../worker-prompts.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { formatVitals } from '../../tools/session-vitals.js'
import { READ_FILE_TOOL, __resetSessionFileEditsForTests } from '../../tools/read-file.js'
import { HASH_EDIT_TOOL } from '../../tools/hash-edit.js'
import { createHash } from 'node:crypto'
import { repositoryCapability } from '../repository-capability.js'
import { writeHandoffCoverage, readHandoffWithCoverage, writeHandoffTail } from '../handoff-coverage.js'
import { SessionContext } from '../context.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { ArtifactStore } from '../../artifact/store.js'
import { PostTurnDecisionController } from '../post-turn-decision.js'
import { RequestContextController } from '../request-context-controller.js'
import { createSidePathUsageRecorder, drainSidePathUsage } from '../side-path-usage-recorder.js'
import { getSessionDir } from '../session-persist.js'
import { persistWorkerDispatch, workerDispatchIsDurable } from '../worker-dispatch-audit.js'
import { coordinatorSubagentsDir } from '../worker-result-store.js'

test('dispatch with saved history but failed result write cannot acknowledge continuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-dispatch-durable-')), previous = process.env.RIVET_HOME
  process.env.RIVET_HOME = dir
  try {
    const order = createReadOnlyWorkOrder({ id: 'audit-worker', parentTurnId: 'p', objective: 'inspect', profile: 'code_scout', kind: 'code_search', scope: {} })
    const result: WorkerResult = { workOrderId: order.id, status: 'passed', summary: 'observed', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified' }
    mkdirSync(join(coordinatorSubagentsDir(), 'audit-worker.json'), { recursive: true })
    persistWorkerDispatch(order, 'round', [result], { sessionMessages: [{ role: 'user', content: 'complete history' }] }, {})
    const manifest = JSON.parse(readFileSync(join(coordinatorSubagentsDir(), 'audit-worker.round.dispatch.json'), 'utf8'))
    assert.equal(manifest.historySaved, true); assert.equal(manifest.resultsSaved, false); assert.equal(manifest.persistenceStatus, 'failed')
    assert.equal(workerDispatchIsDurable(order.id, 'round', 0), false)
    assert.ok(result.risks.some(r => r.includes('result could not be persisted')))
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reasoning recovery runs at most once, respects cancellation and turns, and stamps the actual request', async () => {
  const state = { streamedText: '', thinkingOnlyRetries: 0, lastThinkingContent: '' }
  const fake = { reasoningRecoveryPending: false, config: { promptEngine: { getRequestBudgetPolicy: () => undefined } } } as any
  const ctrl = new PostTurnDecisionController({ state, getDoomLoopLevel: () => 'none', appendSystemReminder: () => {},
    appendSystemReminderAndReport: () => true, completeTurn: async () => {}, getTotalUsage: () => ({}) as any,
    getTurnCount: () => 1, maxTurns: 3, markReasoningRecovery: () => { fake.reasoningRecoveryPending = true } })
  const params = { collectedBlockCount: 0, thinkingAccum: 'reasoning', turn: 0, callbacks: { onTurnComplete: () => {} } as any, signal: new AbortController().signal }
  assert.equal((await ctrl.evaluateThinkingRetry(params)).shouldRetry, true)
  const request = await new RequestContextController(fake).prepare(() => ({ model: 'fixture', messages: [] }), {} as any)
  assert.equal(request.diagnostics?.purpose, 'reasoning_recovery')
  await ctrl.evaluateThinkingRetry({ ...params, collectedBlockCount: 1 })
  assert.equal((await ctrl.evaluateThinkingRetry(params)).shouldRetry, false)
  state.thinkingOnlyRetries = 0
  assert.equal((await ctrl.evaluateThinkingRetry({ ...params, turn: 2 })).shouldRetry, false)
  assert.equal((await ctrl.evaluateThinkingRetry({ ...params, signal: AbortSignal.abort() })).shouldRetry, false)
})

test('side-path ledger drains output-only and unknown attempts with the actual provider identity', async () => {
  const cwd = temporary(), previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  try {
    const session = new SessionContext(), fake = { session, cwd, config: { sessionId: 'side-ledger', providerName: 'primary-provider' } } as any
    const record = createSidePathUsageRecorder(fake)
    record('vision-description', { output_tokens: 7, observation: { requestId: 'r1', attemptId: 'a1', fields: {}, wire: { provider: 'vision-provider', model: 'vision-model' } } } as any)
    record('vision-question', { observation: { requestId: 'r2', attemptId: 'a2', status: 'aborted', fields: {} } } as any, 'vision-model', 'vision-provider')
    await drainSidePathUsage(fake)
    const rows = readFileSync(join(getSessionDir(cwd), 'side-ledger', 'cache-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).sort((a, b) => a.requestId.localeCompare(b.requestId))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].provider, 'vision-provider'); assert.equal(rows[0].model, 'vision-model')
    assert.equal(rows[0].input, null); assert.equal(rows[0].output, 7)
    assert.equal(rows[1].input, null); assert.equal(rows[1].output, null); assert.equal(rows[1].hitRate, null)
    assert.equal(session.getTotalUsage().output_tokens, 7)
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    rmSync(cwd, { recursive: true, force: true })
  }
})

const root = resolve('.test-tmp'); mkdirSync(root, { recursive: true })
const temporary = () => mkdtempSync(join(root, 'cache-worker-hardening-'))
const engine = () => new PromptEngine({ model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: root } })
const summary = JSON.stringify({ version: 1, summary: 'Observed historical data, verification remains unverified.', facts: [], requirements: [], pendingApprovals: [] })
const history = (): OaiMessage[] => [{ role: 'user', content: 'old user task' }, { role: 'assistant', content: 'large old observation '.repeat(1000) }, { role: 'user', content: 'latest human task' }, { role: 'assistant', content: 'recent1' }, { role: 'user', content: 'recent2' }, { role: 'assistant', content: 'recent3' }]

for (const raw of ['<｜DSML｜tool_calls>{"findings":[]}', '{"version":1,"summary":"half', 'plain prose', JSON.stringify({ version: 1, summary: 'bad reference', facts: [{ text: 'fact', references: [999], status: 'observed' }], requirements: [], pendingApprovals: [] })]) {
  test(`budget summary quality refuses ${raw.slice(0, 20)} without archive or history commit`, async () => {
    const messages = history(), old = JSON.stringify(messages)
    let writes = 0, events = 0
    const changed = await compactBudgetHistory(messages, { model: 'fixture', client: { stream: async (request, cb) => { assert.deepEqual(request.response_format, { type: 'json_object' }); cb.onTextDelta(raw); cb.onStopReason('stop', {}) } }, archive: async () => { writes++; return 'ref' }, commit: async () => { writes++ }, recordEvent: () => { events++ } })
    assert.equal(changed, false); assert.equal(writes, 0); assert.equal(JSON.stringify(messages), old); assert.equal(events, 1)
  })
}

test('budget summary forwards output-only and unknown attempts once; commit emits one coverage event', async () => {
  const usage: unknown[] = [], events: unknown[] = [], order: string[] = []
  const changed = await compactBudgetHistory(history(), { model: 'fixture', client: { stream: async (_request, cb) => {
    cb.onStreamAttemptAborted?.({ requestId: 'r', attemptId: 'a', reason: 'fixture', usage: { observation: { requestId: 'r', attemptId: 'a', status: 'aborted', fields: {} } } } as any)
    cb.onTextDelta(summary); cb.onStopReason('stop', { output_tokens: 4 })
  } }, recordUsage: u => usage.push(u), recordEvent: e => events.push(e), archive: async () => { order.push('archive'); return 'ref' }, commit: async () => { order.push('commit') } })
  assert.equal(changed, true); assert.equal(usage.length, 2); assert.deepEqual(order, ['archive', 'commit']); assert.equal(events.length, 1)
  const event = events[0] as { rewriteTransactionId: string; beforeDigest: string; afterDigest: string }
  assert.ok(event.rewriteTransactionId); assert.match(event.beforeDigest, /^[a-f0-9]{64}$/); assert.match(event.afterDigest, /^[a-f0-9]{64}$/)
  assert.notEqual(event.beforeDigest, event.afterDigest)
})

test('budget summary preserves old human requirements and pending approval verbatim', async () => {
  const messages = history()
  messages[0] = { role: 'user', origin: 'human', content: 'Do not publish; approval is still pending. Keep all original requirements.' }
  let committed: OaiMessage[] = []
  assert.equal(await compactBudgetHistory(messages, { model: 'fixture', client: { stream: async (_request, cb) => { cb.onTextDelta(summary); cb.onStopReason('stop', {}) } }, archive: async () => 'ref', commit: async next => { committed = next } }), true)
  assert.ok(committed.some(m => JSON.stringify(m) === JSON.stringify(messages[0])))
})

test('bounded side question omits giant history without changing execution options and records output-only', async () => {
  const promptEngine = engine(), messages: OaiMessage[] = [{ role: 'user', content: 'giant-history '.repeat(100_000) }, { role: 'assistant', content: 'usable finding' }]
  let calls = 0, usages = 0
  const deps = { promptEngine, contextWindow: 1_000_000, getMessages: () => messages, recordUsage: () => { usages++ }, client: { stream: async (r: any, cb: any) => { calls++; assert.ok(JSON.stringify(r).length < 65_536); assert.equal(r.tools, undefined); assert.equal(r.tool_choice, undefined); assert.equal(r.diagnostics.purpose, 'side_question'); cb.onTextDelta('answer'); cb.onStopReason('stop', { output_tokens: 2 }) } } }
  assert.equal(await askSidePath(deps, { instruction: 'Explain the finding' }), 'answer'); assert.equal(usages, 1)
  assert.equal(await askSidePath(deps, { instruction: 'Explain', contextMode: 'full' }), null); assert.equal(calls, 1)
  assert.equal(messages[0]!.content, 'giant-history '.repeat(100_000))
})

test('vision description and question account normal output and unknown aborted usage', async () => {
  for (const purpose of ['vision_description', 'vision_question'] as const) {
    const usages: unknown[] = []
    const answer = await describeImages({ stream: async (r, cb) => { assert.equal(r.diagnostics?.purpose, purpose); cb.onStreamAttemptAborted?.({ requestId: 'r', attemptId: 'a', usage: { observation: { requestId: 'r', attemptId: 'a', status: 'aborted', fields: {} } } } as any); cb.onTextDelta('OCR'); cb.onStopReason('stop', { output_tokens: 3 }) } }, ['data:image/png;base64,' + 'A'.repeat(128)], { purpose, recordUsage: u => usages.push(u) })
    assert.equal(answer, 'OCR'); assert.equal(usages.length, 2)
  }
  assert.notEqual(visionCacheKey(undefined, 'first custom prompt'), visionCacheKey(undefined, 'second custom prompt'))
  assert.notEqual(visionCacheKey('Read ABC'), visionCacheKey('Read abc'))
})

test('tiering single-line JSON never doubles text; colon references remain recoverable', async () => {
  const original = JSON.stringify({ finding: 'x'.repeat(20_000) })
  const output = await tierToolResult('delegate_task', original, 'worker', undefined, 1_000_000)
  assert.ok(output.content.length < 8000); assert.match(output.content, /not saved/); assert.doesNotMatch(output.content, /full content on disk/)
  assert.equal(extractTrailingArtifactId('[artifact:worker-batch-0:a1%3Ab]'), 'worker-batch-0:a1%3Ab')
})

test('worker packet JSON retains all order coverage and a durable complete artifact', async () => {
  const cwd = temporary()
  try {
    const store = new ArtifactStore(cwd, 'packet')
    const results: WorkerResult[] = Array.from({ length: 20 }, (_, i) => ({ workOrderId: `large:${i}`, objective: `objective ${i}`, status: 'passed', summary: 'short', findings: [{ claim: 'x'.repeat(60_000), evidence: 'a.ts:1', confidence: 'high' }], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' }))
    const packet = await buildPrimaryWorkerPacket(results, store)
    const parsed = JSON.parse(packet.match(/<worker_results>([\s\S]*?)<\/worker_results>/)![1]!)
    assert.equal(parsed.length, results.length); assert.ok(packet.length <= 32_000)
    const id = packet.match(/\[artifact:([^\]]+)]/)![1]!
    const full = JSON.parse((await store.readRaw(id))!)
    assert.equal(full.length, results.length); assert.equal(full[0].findings[0].claim.length, 60_000)
    assert.equal(parsed[0]._coverage.findingCount, 1); assert.equal(parsed[0].evidenceStatus, 'unverified')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('reuse fingerprint binds project, file bytes and provider without mutating scope', () => {
  const first = temporary(), second = temporary()
  try {
    for (const cwd of [first, second]) { writeFileSync(join(cwd, 'a.ts'), 'first'); writeFileSync(join(cwd, 'b.ts'), 'second') }
    const order = createReadOnlyWorkOrder({ parentTurnId: 'fingerprint', objective: 'Inspect byte stability across projects', profile: 'code_scout', kind: 'code_search', scope: { files: ['b.ts', 'a.ts'] } })
    const config = { cwd: first, providerName: 'p1', promptEngine: engine(), toolRegistry: new ToolRegistry(), baseUrl: 'https://example.invalid' } as any
    const fp = workerResultFingerprint(order, config); assert.ok(fp); assert.deepEqual(order.scope.files, ['b.ts', 'a.ts'])
    assert.notEqual(workerResultFingerprint(order, { ...config, cwd: second }), fp)
    assert.notEqual(workerResultFingerprint(order, { ...config, providerName: 'p2' }), fp)
    writeFileSync(join(first, 'a.ts'), 'changed'); assert.notEqual(workerResultFingerprint(order, config), fp)
    assert.equal(workerResultFingerprint(order, { ...config, providerName: undefined }), undefined)
  } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }) }
})

test('position anchors refuse same-mtime content drift and ambiguous hash recovery without writing', async () => {
  const cwd = temporary(), path = join(cwd, 'a.css')
  try {
    writeFileSync(path, '.one {color:red;}\n.two {color:blue;}\n')
    const before = statSync(path)
    await READ_FILE_TOOL.execute({ cwd, toolUseId: 'read', input: { file_path: path } })
    const changed = '.two {color:red;}\n.one {color:blue;}\n'; writeFileSync(path, changed); utimesSync(path, before.atime, before.mtime)
    const result = await HASH_EDIT_TOOL.execute({ cwd, toolUseId: 'edit', input: { file_path: path, anchors: ['L1'], new_string: '.wrong {}' } })
    assert.equal(result.isError, true); assert.equal(readFileSync(path, 'utf8'), changed)
    const duplicate = 'inserted\nidentical\nidentical\n'; writeFileSync(path, duplicate)
    const hash = createHash('sha256').update('identical').digest('hex').slice(0, 8)
    const ambiguous = await HASH_EDIT_TOOL.execute({ cwd, toolUseId: 'edit2', input: { file_path: path, anchors: [`L1:${hash}`], new_string: 'wrong' } })
    assert.equal(ambiguous.isError, true); assert.equal(readFileSync(path, 'utf8'), duplicate)
  } finally { __resetSessionFileEditsForTests(); rmSync(cwd, { recursive: true, force: true }) }
})

test('vitals uses cache-inclusive input and preserves unknown denominator', () => {
  const v = { turn: 1, ctx: { estimatedTokens: 1, contextWindow: 10, ratio: .1 }, cache: [{ turn: 1, cacheRead: 50, cacheCreation: 0, inputTokens: 100 }, { turn: 2, cacheRead: 50, cacheCreation: 0 }], sensorium: null, cvm: { overheadRatio: 0, throttled: false, ceiling: false }, advisories: { rendered: 0, dropped: 0, adopted: 0, ignored: 0, top: [] } }
  const text = formatVitals(v); assert.match(text, /命中≈50.0%/); assert.match(text, /input=unknown 命中≈n\/a/); assert.doesNotMatch(text, /100.0%/)
  const diagnostic = formatVitals({ ...v, diagnostics: { mainPrefixBaseline: 'baseline_missing', mainUsageCoverage: { observed: 3, unknown: 2 }, compact: [{ status: 'rejected', reason: 'schema_failed', rewriteTransactionId: 'txn' }] } })
  assert.match(diagnostic, /known=3 unknown=2/); assert.match(diagnostic, /baseline_missing/); assert.match(diagnostic, /compact=rejected transaction=txn reason=schema_failed/)
})

test('handoff coverage is bound to session, content and revision; manual text survives', () => {
  const cwd = temporary(), path = join(cwd, 'session.handoff.md')
  try {
    writeFileSync(path, 'manual body'); writeHandoffCoverage(path, 'session', 'manual body', 4)
    assert.equal(readHandoffWithCoverage(path, 'session', 4), 'manual body')
    assert.match(readHandoffWithCoverage(path, 'session', 5), /stale/)
    writeHandoffTail(path, 'session', 'latest tail', 5)
    assert.match(readHandoffWithCoverage(path, 'session', 5), /latest tail/)
    assert.doesNotMatch(readHandoffWithCoverage(path, 'session', 6), /latest tail/)
    writeFileSync(path, 'human revised body'); assert.match(readHandoffWithCoverage(path, 'session', 5), /unknown/)
    assert.doesNotMatch(readHandoffWithCoverage(path, 'session', 5), /latest tail/)
    assert.equal(readFileSync(path, 'utf8'), 'human revised body')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('non-repository capability updates after git init without treating transient errors as nonrepo', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-nonrepo-'))
  try {
    assert.equal(await repositoryCapability(cwd), 'non_repository')
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' })
    assert.equal(await repositoryCapability(cwd), 'repository')
    assert.equal(await repositoryCapability(join(cwd, 'missing')), 'unknown')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('local input origin persists through history but never changes wire prefix', () => {
  const session = new SessionContext(), promptEngine = engine()
  session.addUserMessage('Do not change user constraints', undefined, 'runtime_command')
  const message = session.getMessages()[0]!
  assert.equal(message.role === 'user' && message.origin, 'runtime_command')
  const request = promptEngine.buildOaiRequest(session.getMessages())
  assert.equal(JSON.stringify(request.messages).includes('"origin"'), false)
})
