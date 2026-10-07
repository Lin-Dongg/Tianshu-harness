import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent, type SessionRecord } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

class Agent implements ManagedAgent {
  runs = 0
  finish?: () => void
  run(_prompt: string, _callbacks: AgentCallbacks) { this.runs++; return new Promise<void>(resolve => { this.finish = resolve }) }
  abort() { this.finish?.() }
  listArtifacts() { return [] }
  readArtifact() { return Promise.resolve(null) }
  getMessages() { return [] }
  replaceMessages() {}
  rewindToMessages() {}
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) assert.fail('timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('real first-run hook titles human input, persists the result and invalidates the list', async () => {
  const agent = new Agent()
  const saved: SessionRecord[] = [], notifications: string[] = [], inputs: string[] = []
  let generated!: (title: string) => void
  const manager = new RuntimeSessionManager({ defaultCwd: '/tmp', createAgent: () => agent,
    defaultModelId: 'main:model',
    resolveGoalHandles: () => ({ goalTrackerRef: { current: null }, sessionDir: '/tmp', allProviders: {} }),
    titleCompletion: () => (_sys, input) => { inputs.push(input); return new Promise(resolve => { generated = resolve }) },
    onSessionsChanged: reason => notifications.push(reason),
    persistence: { saveRecord: record => saved.push({ ...record }), appendEvent: () => {}, loadAll: () => [] },
  })
  const record = manager.createSession({ cwd: '/tmp' })
  assert.equal(manager.run(record.id, 'EXPANDED ATTACHMENT CONTENT', undefined, false, undefined, { promptText: 'Fix session navigation' }), true)
  await until(() => inputs.length > 0)
  assert.equal(manager.getSession(record.id)?.title, 'Fix session navigation')
  assert.match(inputs[0]!, /Fix session navigation/)
  assert.doesNotMatch(inputs[0]!, /EXPANDED ATTACHMENT/)
  const before = notifications.length
  generated('Session navigation')
  await until(() => manager.getSession(record.id)?.titleSource === 'generated')
  assert.equal(saved.at(-1)?.title, 'Session navigation')
  assert.ok(notifications.length > before, 'title write must notify the sidebar')
  agent.finish?.()
  await manager.shutdownAll()
})

test('second human submit retries using the opener, never a runtime continuation', async () => {
  const agent = new Agent()
  let calls = 0
  const inputs: string[] = []
  const manager = new RuntimeSessionManager({ defaultCwd: '/tmp', createAgent: () => agent, defaultModelId: 'main:model',
    resolveGoalHandles: () => ({ goalTrackerRef: { current: null }, sessionDir: '/tmp', allProviders: {} }),
    titleCompletion: () => async (_sys, input) => { inputs.push(input); calls++; return calls === 1 ? '' : 'Successful retry' },
  })
  const rec = manager.createSession({ cwd: '/tmp' })
  manager.run(rec.id, 'Original task')
  await until(() => manager.getSession(rec.id)?.titleGenerationState === 'failed')
  agent.finish?.(); await until(() => manager.getSession(rec.id)?.status !== 'running')
  manager.run(rec.id, 'continue', undefined, false, undefined, { origin: 'runtime_command' })
  await until(() => agent.runs === 2)
  assert.equal(calls, 1)
  agent.finish?.(); await until(() => manager.getSession(rec.id)?.status !== 'running')
  manager.run(rec.id, 'Follow-up task')
  await until(() => manager.getSession(rec.id)?.titleSource === 'generated')
  assert.match(inputs[1]!, /Original task/)
  assert.doesNotMatch(inputs[1]!, /Follow-up task/)
  agent.finish?.(); await manager.shutdownAll()
})

test('title-generation route is authenticated and protects a concurrent manual rename', async () => {
  let finish!: (title: string) => void
  const agent = new Agent()
  const manager = new RuntimeSessionManager({ defaultCwd: '/tmp', createAgent: () => agent, defaultModelId: 'main:model',
    resolveGoalHandles: () => ({ goalTrackerRef: { current: null }, sessionDir: '/tmp', allProviders: {} }),
    titleCompletion: () => () => new Promise(resolve => { finish = resolve }),
  })
  const rec = manager.createSession({ cwd: '/tmp' })
  manager.run(rec.id, 'Original task')
  await until(() => !!finish)
  const router = createRouter(buildSessionRoutes(manager, 'test-auth'))
  const path = `/sessions/${rec.id}/title-generation`
  assert.equal((await router('POST', path, {})).status, 401)
  const pending = router('POST', path, { explicit: true }, { authorization: 'Bearer test-auth' })
  manager.setTitle(rec.id, 'Manual choice')
  finish('Automatic title')
  assert.equal((await pending).status, 200)
  assert.equal(manager.getSession(rec.id)?.title, 'Manual choice')
  agent.finish?.(); await manager.shutdownAll()
})


test('opening a legacy session reads only its log and uses the live model', async () => {
  const rec: SessionRecord = { id: 'legacy-title', cwd: '/tmp', status: 'idle', createdAt: 1, updatedAt: 1, lastSeq: 1, pendingApprovals: 0, model: 'old:model', title: 'Original request', titleSource: 'fallback', titleGenerationState: 'pending', titleGenerationAttempts: 1 }
  const reads: string[] = [], refs: string[] = []
  const manager = new RuntimeSessionManager({ defaultCwd: '/tmp', createAgent: () => new Agent(), defaultModelId: 'default:model',
    resolveGoalHandles: () => ({ goalTrackerRef: { current: null }, sessionDir: '/tmp', allProviders: {}, currentModelRef: 'live:key:model' }),
    titleCompletion: ref => { refs.push(ref); return async () => 'Recovered title' },
    persistence: { saveRecord: () => {}, appendEvent: () => {}, loadAll: () => [], loadRecords: () => [rec], loadEvents: () => [],
      loadEventsAsync: async id => { reads.push(id); return [{ seq: 1, ts: 1, type: 'user', data: { text: 'Expanded file', promptText: 'Original request' } }] },
    },
  })
  assert.equal(manager.getSession(rec.id)?.titleGenerationState, 'failed', 'an interrupted title request must not stay pending after restart')
  assert.deepEqual(reads, [], 'startup must not title or load every historical session')
  assert.deepEqual(refs, [])
  await manager.generateTitle(rec.id)
  assert.equal(manager.getSession(rec.id)?.title, 'Recovered title')
  assert.deepEqual(refs, ['live:key:model'], 'consume the actual live model rather than the saved/default model')
  assert.ok(reads.length > 0 && reads.every(id => id === rec.id))
  await manager.shutdownAll()
})

test('attachment-only first submit uses the attachment name, never expanded content', async () => {
  const agent = new Agent(), inputs: string[] = []
  const manager = new RuntimeSessionManager({ defaultCwd: '/tmp', createAgent: () => agent, defaultModelId: 'main:model',
    resolveGoalHandles: () => ({ goalTrackerRef: { current: null }, sessionDir: '/tmp', allProviders: {} }),
    titleCompletion: () => async (_sys, input) => { inputs.push(input); return '' },
  })
  const rec = manager.createSession({ cwd: '/tmp' })
  manager.run(rec.id, 'Expanded private document contents', undefined, false, undefined, { promptText: '', documentRefs: [{ id: 'doc', name: 'report.pdf', bytes: 10, mime: 'application/pdf' }] })
  await until(() => manager.getSession(rec.id)?.titleGenerationState === 'failed')
  assert.equal(manager.getSession(rec.id)?.title, 'report.pdf')
  assert.match(inputs[0]!, /report.pdf/)
  assert.doesNotMatch(inputs[0]!, /Expanded private/)
  agent.finish?.(); await manager.shutdownAll()
})
