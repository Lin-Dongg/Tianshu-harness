import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareContextRequest, canRecoverContextRejection } from '../context-budget-preparation.js'
import { compactBudgetHistory } from '../budget-compaction.js'
import type { OaiMessage } from '../../api/oai-types.js'

const policy = { windowTokens: 1_048_576, maxOutputTokens: 393_216 }
test('actual request preparation compacts when input exceeds 90% of the realistic input budget', async () => {
  let content = 'x'.repeat(850_000 * 4), compacts = 0
  const states: string[] = []
  const req = await prepareContextRequest({ policy,
    build: () => ({ model: 'deepseek-flash', max_tokens: 384_000, messages: [{ role: 'user', content }], stream: true }),
    compact: async () => { compacts++; content = 'summarized'; return true },
    publish: b => states.push(b.state),
  })
  assert.equal(compacts, 1)
  assert.ok(states.includes('compacting'))
  assert.ok(req.contextBudget!.inputTokens < req.contextBudget!.inputBudget)
})

test('unproductive compaction has a finite budget and cannot send an oversized request', async () => {
  let compacts = 0
  await assert.rejects(prepareContextRequest({ policy,
    build: () => ({ model: 'deepseek-flash', max_tokens: 384_000, messages: [{ role: 'user', content: 'x'.repeat(4_000_000) }], stream: true }),
    compact: async () => { compacts++; return true }, publish: () => {},
  }), { name: 'ContextBudgetExceededError' })
  assert.equal(compacts, 2)
})

function history(): OaiMessage[] {
  return [
    { role: 'user', content: 'old task' },
    { role: 'assistant', content: 'old answer'.repeat(1000), reasoning_content: 'full reasoning' },
    { role: 'user', content: 'current task' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'done' },
    { role: 'assistant', content: 'done' },
  ]
}

test('archive failure cannot commit a lossy summary or erase images and reasoning', async () => {
  const messages = history(), original = JSON.stringify(messages)
  let committed = false
  await assert.rejects(compactBudgetHistory(messages, { model: 'deepseek-flash',
    client: { stream: async (_r, cb) => { cb.onTextDelta(JSON.stringify({version:1,summary:'summary',facts:[],requirements:[],pendingApprovals:[]})); cb.onStopReason('stop', {}) } },
    archive: async old => { assert.equal(old[1]?.role, 'assistant'); throw new Error('disk full') },
    commit: async () => { committed = true },
  }), /disk full/)
  assert.equal(committed, false)
  assert.equal(JSON.stringify(messages), original)
})

test('commit follows durable archive and preserves the latest user and complete tool pair', async () => {
  const messages = history(), order: string[] = []
  let result: OaiMessage[] = []
  assert.equal(await compactBudgetHistory(messages, { model: 'deepseek-flash',
    client: { stream: async (r, cb) => { assert.ok(!r.tools); cb.onTextDelta(JSON.stringify({version:1,summary:'summary',facts:[],requirements:[],pendingApprovals:[]})); cb.onStopReason('stop', {}) } },
    archive: async old => { order.push('archive'); assert.equal((old[1] as any).reasoning_content, 'full reasoning'); return 'ref' },
    commit: async candidate => { order.push('commit'); result = candidate },
  }), true)
  assert.deepEqual(order, ['archive', 'commit'])
  assert.equal(result[1], messages[0], 'old human instructions also survive verbatim')
  assert.equal(result[2], messages[2])
  assert.equal(result[3], messages[3])
  assert.equal(result[4], messages[4])
})

test('cancelled preparations never summarize or submit', async () => {
  const c = new AbortController(); c.abort()
  await assert.rejects(prepareContextRequest({ policy, signal: c.signal,
    build: () => { throw new Error('must not build') },
    compact: async () => { throw new Error('must not compact') }, publish: () => {},
  }), { name: 'AbortError' })
})

test('small reclaim never breaks a paid prefix', async () => {
  let commits = 0
  assert.equal(await compactBudgetHistory(history(), { model: 'deepseek-flash', minReclaimTokens: 32_768,
    client: { stream: async (_r, cb) => { cb.onTextDelta(JSON.stringify({version:1,summary:'summary',facts:[],requirements:[],pendingApprovals:[]})); cb.onStopReason('stop', {}) } },
    archive: async () => 'ref', commit: async () => { commits++ },
  }), false)
  assert.equal(commits, 0)
})

test('context rejection recovery only replays explicit pre-output rejections', () => {
  const error = Object.assign(new Error('context_length_exceeded'), { status: 400 })
  assert.equal(canRecoverContextRejection(error, 0, 0), true)
  assert.equal(canRecoverContextRejection(error, 1, 0), false)
  assert.equal(canRecoverContextRejection(error, 0, 1), false)
  assert.equal(canRecoverContextRejection(Object.assign(new Error('too large'), { status: 413 }), 0, 0), false)
  assert.equal(canRecoverContextRejection(new Error('context_length_exceeded'), 0, 0), false)
})

test('a late system reminder cannot replace the active user in the protected set', async () => {
  const messages = history()
  messages.push({ role: 'user', content: '<system-reminder>injected</system-reminder>' }, { role: 'assistant', content: 'later' })
  let result: OaiMessage[] = []
  assert.equal(await compactBudgetHistory(messages, { model: 'deepseek-flash', protectedUser: messages[2],
    client: { stream: async (_r, cb) => { cb.onTextDelta(JSON.stringify({version:1,summary:'summary',facts:[],requirements:[],pendingApprovals:[]})); cb.onStopReason('end_turn', {}) } },
    archive: async () => 'ref', commit: async candidate => { result = candidate },
  }), true)
  assert.ok(result.includes(messages[2]!))
  assert.ok(result.includes(messages[3]!))
  assert.ok(result.includes(messages[4]!))
})

for (const reason of ['max_tokens', 'length', 'unknown', 'tool_use']) {
  test(`incomplete summary (${reason}) never publishes a rewrite`, async () => {
    let archived = false
    assert.equal(await compactBudgetHistory(history(), { model: 'deepseek-flash',
      client: { stream: async (_r, cb) => { cb.onTextDelta('partial summary'); cb.onStopReason(reason, {}) } },
      archive: async () => { archived = true; return 'ref' }, commit: async () => { assert.fail('must not publish') },
    }), false)
    assert.equal(archived, false)
  })
}

test('large multimodal text is chunked even when attached to an image', async () => {
  const messages = history()
  messages[0] = { role: 'user', origin: 'hook', content: [{ type: 'text', text: '汉'.repeat(120_000) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }
  const { estimateBudgetInput } = await import('../../context/request-budget.js')
  let calls = 0
  await compactBudgetHistory(messages, { model: 'deepseek-flash',
    client: { stream: async (request, cb) => {
      calls++
      assert.ok(estimateBudgetInput(request.messages).inputTokens < 33_000)
      cb.onTextDelta(JSON.stringify({version:1,summary:'summary',facts:[],requirements:[],pendingApprovals:[]})); cb.onStopReason('end_turn', {})
    } }, archive: async () => 'ref', commit: async () => {},
  })
  assert.ok(calls > 1)
})
