import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

function setup(timeout = 0) {
  let callbacks!: AgentCallbacks
  let finish!: () => void
  const agent: ManagedAgent = {
    run: (_prompt: string, cb: AgentCallbacks) => { callbacks = cb; return new Promise<void>(r => { finish = r }) },
    abort: () => { callbacks.onAbort?.(); finish() },
    listArtifacts: () => [], readArtifact: async () => null,
    getMessages: () => [], replaceMessages: () => {}, rewindToMessages: () => {},
  }
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: '/tmp/approval-work', maxEvents: 100, approvalTimeoutMs: timeout })
  const session = manager.createSession({ prompt: 'probe', approvalMode: 'manual' })
  const routes = buildSessionRoutes(manager, 'fixture-auth')
  return { manager, session, routes, cb: callbacks }
}
const auth = { authorization: 'Bearer fixture-auth' }

test('live snapshot survives ring eviction, preserves every request and redacts input', async () => {
  const { manager, session, routes, cb } = setup()
  try {
    const a = cb.onApprovalRequired('a', 'read_file', { file_path: '/outside/a', api_key: 'fixture-sensitive-value' })
    const b = cb.onApprovalRequired('b', 'read_file', { file_path: '/outside/b' })
    for (let i = 0; i < 150; i++) cb.onPhaseChange?.('working', { reason: `probe ${i}` })
    assert.equal(manager.getEvents(session.id)!.events.some(e => e.type === 'approval_required'), false)
    const route = routes['GET /sessions/:id/interventions']!
    assert.equal((await route({}, { id: session.id }, {})).status, 401)
    const result = await route({}, { id: session.id }, auth)
    assert.equal(result.status, 200)
    const snapshot = manager.getApprovalSnapshot(session.id)!
    assert.deepEqual(snapshot.approvals.map(p => p.requestId), ['a', 'b'])
    assert.equal(manager.getSession(session.id)!.pendingApprovals, snapshot.approvals.length)
    assert.ok(snapshot.approvals[0]!.pathGrant)
    assert.ok(!JSON.stringify(snapshot).includes('fixture-sensitive-value'))
    manager.answerIntervention(session.id, 'a', 'approve')
    assert.deepEqual(await a, { approved: true })
    assert.deepEqual(manager.getApprovalSnapshot(session.id)!.approvals.map(p => p.requestId), ['b'])
    manager.abort(session.id)
    assert.deepEqual(await b, { approved: false })
    assert.deepEqual(manager.getApprovalSnapshot(session.id)!.approvals, [])
    assert.equal((await route({}, { id: 'missing' }, auth)).status, 404)
  } finally { manager.abort(session.id) }
})

test('SSE sends authoritative approval snapshot after replay, including an empty snapshot', async () => {
  const { manager, session, routes, cb } = setup()
  const pending = cb.onApprovalRequired('a', 'read_file', { file_path: '/outside/a' })
  for (let i = 0; i < 150; i++) cb.onPhaseChange?.('working', { reason: `probe ${i}` })
  async function stream() {
    const writes: string[] = []
    let close: (() => void) | undefined
    const res = { writeHead() {}, flushHeaders() {}, write(v: string) { writes.push(v); return true }, end() {}, cork() {}, uncork() {}, on(name: string, fn: () => void) { if (name === 'close') close = fn }, writableEnded: false } as unknown as ServerResponse
    await routes['GET /sessions/:id/stream']!({}, { id: session.id }, auth, res)
    const output = writes.join('')
    close?.()
    return output.split('\n\n').filter(v => v.includes('data: ')).map(v => JSON.parse(v.slice(v.indexOf('data: ') + 6)))
  }
  try {
    let frames = await stream()
    const snapshot = frames.find(e => e.type === 'approval_snapshot')
    assert.equal(snapshot.seq, 0)
    assert.deepEqual(snapshot.data.approvals.map((p: { requestId: string }) => p.requestId), ['a'])
    assert.equal(frames.at(-1).type, 'approval_snapshot')
    manager.answerIntervention(session.id, 'a', 'reject')
    await pending
    frames = await stream()
    assert.deepEqual(frames.find(e => e.type === 'approval_snapshot').data.approvals, [])
  } finally { manager.abort(session.id) }
})

test('explicit timeout still denies without default automatic approval', async () => {
  const { manager, session, cb } = setup(5)
  try {
    assert.deepEqual(await cb.onApprovalRequired('a', 'bash', {}), { approved: false })
    assert.deepEqual(manager.getApprovalSnapshot(session.id)!.approvals, [])
    assert.equal(manager.getSession(session.id)!.pendingApprovals, 0)
  } finally { manager.abort(session.id) }
})
