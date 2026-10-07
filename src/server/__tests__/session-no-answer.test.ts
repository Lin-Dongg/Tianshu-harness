import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

test('no_answer completion settles interrupted and permits the next user run', async () => {
  let runs = 0
  const agent: ManagedAgent = {
    run: async (_prompt: string, cb: AgentCallbacks) => {
      runs++
      cb.onTurnComplete({}, 1, true, undefined, undefined, runs === 1 ? 'no_answer' : undefined)
    },
    abort: () => {}, listArtifacts: () => [], readArtifact: async () => null,
    getMessages: () => [], replaceMessages: () => {}, rewindToMessages: () => {},
  }
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: '/tmp', idleAgentTtlMs: 0 })
  const session = manager.createSession({})
  const first = await manager.runAndWait(session.id, 'inspect')
  assert.equal(first.status, 'interrupted')
  const final = manager.getEvents(session.id, 0)!.events.filter(e => e.type === 'turn_complete').at(-1)
  assert.equal(final?.data.stopReason, 'no_answer')
  const done = manager.getEvents(session.id, 0)!.events.filter(e => e.type === 'done').at(-1)
  assert.equal(done?.data.status, 'interrupted')
  assert.equal((await manager.runAndWait(session.id, 'continue')).status, 'completed')
})
