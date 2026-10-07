import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PostTurnDecisionController, type PostTurnDecisionDeps } from '../post-turn-decision.js'
import type { AgentCallbacks } from '../loop-types.js'

function createRecovery(maxTurns?: number) {
  const reminders: string[] = []
  let reservations = 0
  let recoveries = 0
  let completions = 0
  const deps: PostTurnDecisionDeps = {
    state: { streamedText: '', thinkingOnlyRetries: 0, lastThinkingContent: '' },
    maxTurns,
    getDoomLoopLevel: () => 'none',
    appendSystemReminder: () => {},
    appendSystemReminderAndReport: (text, cls) => {
      assert.equal(cls, 'functional')
      reminders.push(text)
      return true
    },
    completeTurn: async () => {},
    getTotalUsage: () => ({ input_tokens: 0, output_tokens: 598, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    getTurnCount: () => 3,
    reserveReasoningRecovery: () => { reservations++; return true },
    markReasoningRecovery: () => { recoveries++ },
  }
  const controller = new PostTurnDecisionController(deps)
  const evaluate = (turn = 2, signal = new AbortController().signal) => controller.evaluateThinkingRetry({
    collectedBlockCount: 0,
    thinkingAccum: 'Let me search for the domain definition.',
    turn,
    signal,
    callbacks: {
      onTurnComplete: (_usage, _turn, isFinal) => {
        assert.equal(isFinal, false)
        completions++
      },
    } as AgentCallbacks,
  })
  return { deps, evaluate, counts: () => ({ reservations, recoveries, completions, reminders: reminders.length }) }
}

describe('thinking-only recovery turn limit', () => {
  it('maxTurns=0 allows one recovery even at a high turn number', async () => {
    const recovery = createRecovery(0)
    assert.equal((await recovery.evaluate(500)).shouldRetry, true)
    assert.deepEqual(recovery.counts(), { reservations: 1, recoveries: 1, completions: 1, reminders: 1 })
    assert.equal((await recovery.evaluate(501)).shouldRetry, false)
    assert.equal(recovery.counts().reservations, 1)
  })

  it('an unspecified limit allows recovery', async () => {
    assert.equal((await createRecovery().evaluate()).shouldRetry, true)
  })

  it('a finite limit allows recovery before the final turn', async () => {
    assert.equal((await createRecovery(4).evaluate(2)).shouldRetry, true)
  })

  it('a finite limit blocks recovery on and beyond the final turn', async () => {
    for (const turn of [2, 3]) {
      const recovery = createRecovery(3)
      assert.equal((await recovery.evaluate(turn)).shouldRetry, false)
      assert.deepEqual(recovery.counts(), { reservations: 0, recoveries: 0, completions: 0, reminders: 0 })
    }
  })

  it('an unlimited turn budget still respects cancellation', async () => {
    const abort = new AbortController()
    abort.abort()
    const recovery = createRecovery(0)
    assert.equal((await recovery.evaluate(2, abort.signal)).shouldRetry, false)
    assert.equal(recovery.counts().reservations, 0)
  })

  it('an unlimited turn budget still respects the shared retry budget', async () => {
    const recovery = createRecovery(0)
    recovery.deps.reserveReasoningRecovery = () => false
    assert.equal((await recovery.evaluate()).shouldRetry, false)
    assert.deepEqual(recovery.counts(), { reservations: 0, recoveries: 0, completions: 0, reminders: 0 })
  })
})
