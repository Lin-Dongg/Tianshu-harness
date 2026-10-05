import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebSearchTool } from '../../tools/web-search/tool.js'
import { BraveBackend } from '../../tools/web-search/brave.js'
import { ToolRegistry } from '../../tools/registry.js'
import { executeToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'
import { TurnHarness } from '../turn-harness.js'
import { TrajectoryRecorder } from '../trajectory.js'
import { EvidenceTracker } from '../evidence.js'
import { createTurnBudget } from '../turn-budget.js'
import { observeRun } from '../stall-observer.js'
import type { SearchBackend } from '../../tools/web-search/types.js'

async function runSearch(backends: SearchBackend[], query: string | undefined = 'q') {
  const cwd = mkdtempSync(join(tmpdir(), 'web-search-error-kind-'))
  try {
    let calls = 0
    const registry = new ToolRegistry()
    const tool = createWebSearchTool({ backends, timeoutMs: 5 })
    registry.register({ ...tool, execute: async params => { calls++; return tool.execute(params) } })
    const trajectory = new TrajectoryRecorder()
    const sessionId = `search-${cwd}`
    const deps = {
      config: {
        toolRegistry: registry, hooks: null, lspEnabled: false, sessionId,
        approvalMode: 'dangerously-skip-permissions',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'fixture' },
      },
      cwd, harness: new TurnHarness({ maxRetries: 2, retryableClasses: ['timeout', 'flaky'] }, trajectory),
      prewarm: { get: () => null, invalidate: () => {} }, evidence: new EvidenceTracker(),
      traceStore: { events: [], toolFingerprints: [] },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: unknown) => ({ output: input, telemetry: [] }) },
      importGraph: null, lastConflictCheckCount: 0, trajectory,
      getDoomLoopLevel: () => 'none', latestRisk: { level: 'none', reasons: [], suggestedAction: '' },
      sessionTurnCount: 1, sessionId, recordToolHistory: () => {}, turnBudget: createTurnBudget(0),
    } as unknown as ToolPipelineDeps
    const callbacks = {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: () => {},
      onTurnComplete: () => {}, onError: () => {}, onAbort: () => {}, onApprovalRequired: async () => true,
    }
    const result = await observeRun(sessionId, () => executeToolUse(
      { id: 'search', name: 'web_search', input: { query } }, deps, callbacks, 1, false,
    ))
    assert.ok(result.toolResult.type === 'tool_result')
    return { result, toolResult: result.toolResult, calls, entry: trajectory.getEntries().at(-1)! }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}

it('real pipeline does not retry web_search for polluted backend diagnostics', async () => {
  const out = await runSearch([{
    name: 'timeout-provider', isAvailable: () => true,
    search: async () => { throw new Error('unsupported query timeout 300 HTTP 503') },
  }])
  assert.equal(out.calls, 1)
  assert.equal(out.result.errorKind, 'unknown')
  assert.equal(out.entry.errorClass, 'unknown')
  assert.doesNotMatch(String(out.toolResult.content), /All \d+ retries failed/)
})

it('real pipeline retains HTTP permission failure despite a timeout backend name', async () => {
  const backend = new BraveBackend(async () => new Response('', { status: 403 }), 'fixture')
  const out = await runSearch([{ ...backend, name: 'timeout-provider', isAvailable: () => true, search: backend.search.bind(backend) }])
  assert.equal(out.calls, 1)
  assert.equal(out.result.errorKind, 'permission_denied')
  assert.equal(out.entry.errorClass, 'permission_denied')
  assert.doesNotMatch(String(out.toolResult.content), /All \d+ retries failed/)
})

it('real pipeline propagates invalid-query classification without searching', async () => {
  let calls = 0
  const out = await runSearch([{ name: 'provider', isAvailable: () => true, search: async () => { calls++; return [] } }], '')
  assert.equal(calls, 0)
  assert.equal(out.calls, 1)
  assert.equal(out.result.errorKind, 'format_error')
  assert.equal(out.entry.errorClass, 'format_error')
})

for (const failure of ['network', 'deadline'] as const) {
  it(`real pipeline retries a genuine ${failure} once and recovers`, async () => {
    let attempts = 0
    const out = await runSearch([{
      name: 'provider', isAvailable: () => true,
      search: async (_query, _count, signal) => {
        if (++attempts > 1) return [{ title: 'q', url: 'https://example.invalid', snippet: 'q' }]
        if (failure === 'network') throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
    }])
    assert.equal(out.calls, 2)
    assert.equal(out.entry.status, 'retried-success')
    assert.equal(out.toolResult.is_error, false)
    assert.equal(out.result.errorKind, undefined)
  })
}

for (const finalFailure of ['unknown', 'permission_denied'] as const) {
  it(`real pipeline stops retrying when a network failure becomes ${finalFailure}`, async () => {
    let attempts = 0
    const denied = new BraveBackend(async () => new Response('', { status: 403 }), 'fixture')
    const out = await runSearch([{
      name: 'provider', isAvailable: () => true,
      search: async (query, count, signal) => {
        if (++attempts === 1) throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
        if (finalFailure === 'unknown') throw new Error('unsupported request timeout')
        return denied.search(query, count, signal)
      },
    }])
    assert.equal(out.calls, 2, 'the permanent second result must stop further retries')
    assert.equal(out.result.errorKind, finalFailure)
    assert.equal(out.entry.errorClass, finalFailure)
    assert.doesNotMatch(String(out.toolResult.content), /All \d+ retries failed/)
  })
}
