import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextClaimStore } from '../../context/claim-store.js'
import { createMemoryTool } from '../../tools/memory.js'

let sessionDir: string
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'rivet-deep-recall-tool-'))
  writeFileSync(join(sessionDir, 'historical.jsonl'), JSON.stringify({
    role: 'assistant', content: 'prefix cache depends on stable system prompt bytes',
  }) + '\n')
})
afterEach(() => rmSync(sessionDir, { recursive: true, force: true }))

function execute(complete: (prompt: string, budget: number) => Promise<string>, query = 'prefix cache') {
  return createMemoryTool({} as ContextClaimStore, {
    sessionId: 'current', getTurn: () => 1, sessionDir,
    embeddingProvider: { id: 'disabled', isAvailable: () => false, embed: async () => [] },
    deepRecallComplete: complete,
  }).execute({ input: { action: 'deep_recall', query }, toolUseId: 'deep-recall', cwd: sessionDir })
}

const valid = JSON.stringify({
  answer: 'cache needs stable bytes',
  evidence: [{ sessionId: 'historical', quote: 'stable system prompt bytes' }],
  uncertainties: [], confidence: 0.8,
})

describe('memory deep_recall #401 bounded format retry', () => {
  it('returns the first valid result without a retry', async () => {
    let calls = 0
    const result = await execute(async () => { calls++; return valid })
    assert.equal(calls, 1)
    assert.ok(!result.isError)
    assert.match(result.content, /cache needs stable bytes/)
    assert.match(result.content, /\[historical\]/)
  })

  for (const malformed of ['unstructured answer', '{"evidence":[]}', '{"answer":""}', '{"answer":"truncated']) {
    it(`retries once after ${malformed}`, async () => {
      const prompts: string[] = []
      const result = await execute(async prompt => {
        prompts.push(prompt)
        return prompts.length === 1 ? malformed : valid
      })
      assert.equal(prompts.length, 2)
      assert.ok(prompts[1]!.startsWith(prompts[0]!))
      assert.match(prompts[1]!, /非空字符串 answer/)
      assert.ok(!prompts[1]!.includes(malformed), 'failed output must not become trusted context')
      assert.ok(!result.isError)
      assert.match(result.content, /cache needs stable bytes/)
    })
  }

  it('fails visibly after two invalid outputs without exposing them as an answer', async () => {
    let calls = 0
    const result = await execute(async () => { calls++; return 'unsupported invented answer' })
    assert.equal(calls, 2)
    assert.equal(result.isError, true)
    assert.match(result.content, /格式重试一次后仍不可解析/)
    assert.ok(!result.content.includes('unsupported invented answer'))
  })

  for (const failAttempt of [1, 2]) {
    it(`does not retry a completion exception on attempt ${failAttempt}`, async () => {
      let calls = 0
      const result = await execute(async () => {
        if (++calls === failAttempt) throw new Error('channel unavailable')
        return 'invalid output'
      })
      assert.equal(calls, failAttempt)
      assert.equal(result.isError, true)
      assert.match(result.content, /侧路模型不可用\/超时/)
      if (failAttempt === 2) assert.match(result.content, /格式重试时/)
    })
  }

  it('gives the retry only the remaining total budget', async t => {
    let clock = 100
    t.mock.method(performance, 'now', () => clock)
    const budgets: number[] = []
    const result = await execute(async (_prompt, budget) => {
      budgets.push(budget)
      if (budgets.length === 1) { clock += 12_000; return 'bad format' }
      return valid
    })
    assert.deepEqual(budgets, [20_000, 8_000])
    assert.ok(!result.isError)
  })

  for (const failure of ['invalid', 'throw', 'valid', 'retry']) {
    it(`reports total budget exhaustion after ${failure}`, async t => {
      let clock = 0
      t.mock.method(performance, 'now', () => clock)
      let calls = 0
      const result = await execute(async () => {
        calls++
        if (failure === 'retry' && calls === 1) { clock = 12_000; return 'invalid' }
        clock = 20_000
        if (failure === 'throw') throw new Error('timeout')
        return failure === 'valid' ? valid : 'invalid'
      })
      assert.equal(calls, failure === 'retry' ? 2 : 1)
      assert.equal(result.isError, true)
      assert.match(result.content, /20 秒总预算已耗尽/)
    })
  }

  it('does not call the model without candidates', async () => {
    let called = false
    const result = await execute(async () => { called = true; return valid }, 'unmatchedword')
    assert.equal(called, false)
    assert.ok(!result.isError)
    assert.match(result.content, /无可蒸馏素材/)
  })
})
