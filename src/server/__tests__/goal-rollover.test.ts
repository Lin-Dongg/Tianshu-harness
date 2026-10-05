import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent, type GoalHandles } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { RecoveryJournal } from '../recovery-journal.js'
import { GoalTracker, GOAL_ROLLOVER_REASON } from '../../agent/goal-tracker.js'
import { rolloverHandoffPath, rolloverMarker } from '../goal-rollover.js'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { GoalRolloverState } from '../goal-rollover-state.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { clearWaveGate, getWaveGate, setWaveGate } from '../../agent/wave-gate.js'

class FakeAgent implements ManagedAgent {
  tracker: GoalTracker | null = null
  prompts: string[] = []
  images: string[][] = []
  allowedTools?: string[]
  disabledSkills = new Set<string>()
  reasoningEffort?: string
  setDisabledSkills(names: Set<string>) { this.disabledSkills = new Set(names) }
  setReasoningEffort(effort: string) { this.reasoningEffort = effort }
  private finishRun?: () => void
  run(prompt: string, _callbacks: AgentCallbacks, images?: string[]) {
    this.prompts.push(prompt); this.images.push(images ?? [])
    return new Promise<void>(r => { this.finishRun = r })
  }
  finish() { const r = this.finishRun; this.finishRun = undefined; r?.() }
  abort() { this.finish() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact() { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages() {}
  rewindToMessages() {}
  setGoalTracker(t: GoalTracker | null) { this.tracker = t }
  getGoalTracker() { return this.tracker }
  getContextWindow() { return 100_000 }
}

async function until(predicate: () => unknown) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for rollover')
    await new Promise(r => setTimeout(r, 5))
  }
}

function fixture(t: { after: (fn: () => Promise<void>) => void }, ensureGate?: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'goal-rollover-'))
  const cwd = join(home, 'work'); mkdirSync(cwd)
  const goals = join(home, 'goals'); mkdirSync(goals)
  const journal = new RecoveryJournal(join(home, 'recovery'))
  const persistence = new FileSessionPersistence(join(home, 'sessions'))
  const agents = new Map<string, FakeAgent>()
  const handles = new Map<string, GoalHandles>()
  const reviewRefs = new Map<string, { current: 'auto' | 'off' }>()
  const extraCleanup: Array<() => Promise<void>> = []
  const manager = new RuntimeSessionManager({ defaultCwd: cwd, persistence, recoveryJournal: journal, externalScanMs: 0,
    createAgent: async (_cwd, id, _approval, _model, allowedTools) => {
      if (agents.size > 0 && ensureGate) await ensureGate()
      const a = new FakeAgent(); a.allowedTools = allowedTools; agents.set(id!, a)
      reviewRefs.set(id!, { current: 'off' })
      handles.set(id!, { goalTrackerRef: { current: null }, sessionDir: goals })
      return a
    }, resolveGoalHandles: id => handles.get(id), resolveReviewGateRef: id => reviewRefs.get(id),
  })
  t.after(async () => {
    for (const cleanup of extraCleanup) await cleanup()
    await manager.shutdownAll()
    await manager.flushGoalRollover()
    await journal.flush()
    persistence.flushSync()
    rmSync(home, { recursive: true, force: true })
  })
  return { manager, agents, journal, persistence, cwd, handles, goals, extraCleanup, reviewRefs }
}

async function begin(f: ReturnType<typeof fixture>, input: Parameters<RuntimeSessionManager['createSession']>[0] = {}, configure?: (id: string) => void) {
  const session = f.manager.createSession({ cwd: f.cwd, title: 'Long goal', ...input })
  await f.manager.ensureSessionAgent(session.id)
  await f.manager.setGoal(session.id, { goal: 'refactor utils', maxIterations: 12, contextWindow: 100_000,
    maxJudgeRuns: 2, wallClockMs: 600_000, rollover: { ratio: .5, maxSessions: 3, generation: 1 } })
  configure?.(session.id)
  assert.equal(f.manager.run(session.id, 'refactor utils'), true)
  const agent = f.agents.get(session.id)!
  await until(() => agent.prompts.length === 1)
  const tracker = f.manager.getSessionGoalTracker(session.id)!
  const latestGoal = f.manager.getEvents(session.id)!.events.filter(e => e.type === 'goal_state').at(-1)!
  assert.equal(latestGoal.data.goalId, tracker.getGoalId(), 'first user input must not overwrite an attached goal with the empty baseline')
  tracker.advanceIteration(); tracker.advanceIteration(); tracker.recordJudgeRun()
  tracker.pause(GOAL_ROLLOVER_REASON)
  agent.finish()
  await until(() => agent.prompts.length === 2)
  const state = (await f.journal.loadGoalRollover(session.id))!
  assert.ok(state)
  return { session, agent, tracker, state }
}
function writeHandoff(state: GoalRolloverState, body = 'utils/string.ts migrated; verify tests') {
  const path = rolloverHandoffPath(state)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${rolloverMarker(state)}\n${body}`)
}

test('full rollover preserves goal identity, budgets, policy and durable lineage', async t => {
  const f = fixture(t)
  const { session, agent, tracker, state } = await begin(f, { allowedTools: ['read_file', 'write_file'], reasoningEffort: 'high', approvalMode: 'manual' }, id => {
    const raw = (f.manager as unknown as { sessions: Map<string, { disabledSkills: Set<string>; reviewGateOverride?: 'auto' | 'off' }> }).sessions.get(id)!
    raw.disabledSkills.add('deployment'); raw.reviewGateOverride = 'auto'
  })
  assert.match(agent.prompts[1]!, new RegExp(state.id))
  assert.doesNotMatch(agent.prompts[1]!, /\.rivet\/HANDOFF\.md/)
  writeHandoff(state); agent.finish()
  await until(() => f.agents.get(state.to!)?.prompts.length)
  await f.manager.flushGoalRollover()
  const next = f.manager.getSession(state.to!)!
  const goal = f.manager.getSessionGoalTracker(next.id)!
  assert.equal(goal.getGoalId(), tracker.getGoalId())
  assert.equal(goal.getIteration(), 2)
  assert.equal(goal.getMaxIterations(), 12)
  assert.equal(goal.getJudgeRuns(), 1)
  assert.equal(goal.getMaxJudgeRuns(), 2)
  assert.equal(goal.getWallClockBudgetMs(), 600_000)
  assert.equal(goal.getRollover()?.generation, 2)
  assert.deepEqual(next.allowedTools, ['read_file', 'write_file'])
  assert.equal(next.reasoningEffort, 'high')
  assert.equal(next.approvalMode, 'manual')
  assert.deepEqual(f.agents.get(next.id)!.allowedTools, ['read_file', 'write_file'])
  assert.equal(f.agents.get(next.id)!.reasoningEffort, 'high')
  assert.deepEqual([...f.agents.get(next.id)!.disabledSkills], ['deployment'])
  assert.equal(f.reviewRefs.get(next.id)?.current, 'auto')
  assert.equal(f.manager.getGoalState(session.id), null)
  assert.equal((await f.journal.loadGoalRollover(session.id))?.phase, 'complete')
  assert.match(f.agents.get(next.id)!.prompts[0]!, /utils\/string/)
  assert.ok(f.manager.getEvents(next.id)?.events.some(e => e.type === 'goal_rollover'))
  assert.equal(f.manager.getEvents(next.id)?.events.some(e => e.type === 'goal_rollover' && e.data.phase === 'cancelled'), false)
})

test('shared/stale/foreign handoffs are never injected; retry uses the same reserved successor', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  mkdirSync(join(f.cwd, '.rivet'), { recursive: true })
  writeFileSync(join(f.cwd, '.rivet/HANDOFF.md'), 'OTHER-SESSION')
  writeHandoff(state, 'foreign'); writeFileSync(rolloverHandoffPath(state), 'WRONG-MARKER\nOTHER-SESSION')
  agent.finish()
  await until(() => f.manager.getSession(session.id)?.goalRollover?.phase === 'paused')
  assert.equal(f.manager.listSessions().length, 1)
  assert.equal(await f.manager.retryGoalRollover(session.id), true)
  await until(() => agent.prompts.length === 3)
  writeHandoff(state, 'OWN-DOCUMENT'); agent.finish()
  await until(() => f.agents.get(state.to!)?.prompts.length)
  assert.doesNotMatch(f.agents.get(state.to!)!.prompts[0]!, /OTHER-SESSION/)
  assert.match(f.agents.get(state.to!)!.prompts[0]!, /OWN-DOCUMENT/)
})

test('cancelling during async successor construction prevents kickoff', async t => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const f = fixture(t, () => gate)
  const { session, agent, state } = await begin(f)
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(state.to!))
  await f.manager.cancelGoal(session.id)
  release()
  await f.manager.flushGoalRollover()
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
  assert.equal((await f.journal.loadGoalRollover(session.id))?.phase, 'cancelled')
})

test('permissions changed during preparation stop rollover', async t => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const f = fixture(t, () => gate)
  const { session, agent, state } = await begin(f)
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(state.to!))
  f.manager.setApprovalMode(session.id, 'auto-safe')
  release()
  await f.manager.flushGoalRollover()
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
})

test('planning and pending approvals block automatic handoff', async t => {
  const f = fixture(t)
  const s = f.manager.createSession({ cwd: f.cwd, planMode: 'planning' })
  await f.manager.ensureSessionAgent(s.id)
  await f.manager.setGoal(s.id, { goal: 'plan', maxIterations: 12, contextWindow: 100_000, rollover: { ratio: .5, maxSessions: 3, generation: 1 } })
  f.manager.run(s.id, 'plan'); await until(() => f.agents.get(s.id)!.prompts.length)
  f.manager.getSessionGoalTracker(s.id)!.pause(GOAL_ROLLOVER_REASON)
  f.agents.get(s.id)!.finish()
  await until(() => f.manager.getSession(s.id)?.goalRollover?.phase === 'paused')
  assert.equal(f.agents.get(s.id)!.prompts.length, 1)
  assert.match(f.manager.getSession(s.id)!.goalRollover!.error!, /只读/)
})

test('uncertain startup after a restart never creates or runs another successor', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  writeHandoff(state); agent.finish()
  await until(() => f.agents.get(state.to!)?.prompts.length)
  await f.manager.flushGoalRollover()
  // Reconstruct the persisted source checkpoint at the crash window before run acceptance was recorded.
  await f.manager.setGoal(session.id, { goal: state.goal.objective, maxIterations: 12, contextWindow: 100_000, resumeRecord: state.goal })
  await f.journal.saveGoalRollover({ ...state, phase: 'starting' })
  f.persistence.flushSync()
  const coldAgents = new Map<string, FakeAgent>()
  const coldHandles = new Map<string, GoalHandles>()
  const cold = new RuntimeSessionManager({ defaultCwd: f.cwd, persistence: f.persistence, recoveryJournal: f.journal, externalScanMs: 0,
    createAgent: (_cwd, id) => {
      const a = new FakeAgent(); coldAgents.set(id!, a)
      coldHandles.set(id!, { goalTrackerRef: { current: null }, sessionDir: f.goals }); return a
    }, resolveGoalHandles: id => coldHandles.get(id),
  })
  f.extraCleanup.push(async () => { await cold.shutdownAll(); await cold.flushGoalRollover() })
  await cold.ensureSessionAgent(session.id)
  await cold.setGoal(session.id, { goal: state.goal.objective, maxIterations: 12, contextWindow: 100_000, resumeRecord: state.goal })
  assert.equal(await cold.retryGoalRollover(session.id), false)
  assert.equal(cold.listSessions().length, 2)
  assert.equal(coldAgents.get(state.to!)?.prompts.length ?? 0, 0)
  assert.match(cold.getSession(session.id)!.goalRollover!.error!, /避免重复执行/)
})

test('POST goal is lazy-agent capable, uses the model window and remains opt-in', async t => {
  const f = fixture(t)
  const router = createRouter(buildSessionRoutes(f.manager, 'test-auth'))
  const s = f.manager.createSession({ cwd: f.cwd })
  const reply = await router('POST', `/sessions/${s.id}/goal`, { goal: 'g', rollover: { ratio: .99, maxSessions: 999 } }, { authorization: 'Bearer test-auth' })
  assert.equal(reply.status, 200)
  assert.deepEqual(f.manager.getGoalState(s.id)?.rollover, { ratio: .9, maxSessions: 20, generation: 1 })
  assert.equal(f.manager.getSessionGoalTracker(s.id)!.getContextWindow(), 100_000)
  const off = f.manager.createSession({ cwd: f.cwd })
  await router('POST', `/sessions/${off.id}/goal`, { goal: 'g' }, { authorization: 'Bearer test-auth' })
  assert.equal(f.manager.getGoalState(off.id)?.rollover, undefined)
})

test('external text and image snapshots are copied into the successor input', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  // Simulate original inputs still referenced after the source event ring was trimmed.
  f.persistence.saveDocument(session.id, 'doc', Buffer.from('ORIGINAL-EXTERNAL-MARKDOWN').toString('base64'), 'notes.md')
  f.persistence.saveImage(session.id, 'img', Buffer.from('image-bytes').toString('base64'), 'image/png')
  const source = f.manager.getSession(session.id)!
  const raw = (f.manager as unknown as { sessions: Map<string, { record: typeof source }> }).sessions.get(session.id)!.record
  raw.goalInputs = { imageIds: ['img'], documents: [{ id: 'doc', name: 'notes.md', bytes: 26, mime: 'text/plain' }] }
  writeHandoff(state); agent.finish()
  await until(() => f.agents.get(state.to!)?.prompts.length)
  await f.manager.flushGoalRollover()
  const next = f.agents.get(state.to!)!
  assert.match(next.prompts[0]!, /ORIGINAL-EXTERNAL-MARKDOWN/)
  assert.equal(next.images[0]![0], `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`)
  const input = f.manager.getEvents(state.to!)!.events.find(e => e.type === 'user')!
  const documents = input.data.documents as Array<{ id: string }>
  assert.equal(f.manager.readDocument(state.to!, documents[0]!.id)?.bytes.toString(), 'ORIGINAL-EXTERNAL-MARKDOWN')
})

test('failed wave gate survives losing the in-memory store and must pass before retry', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  const failed = { wave: 0, passed: false, checks: [], commands: [], changedFiles: [], checkedAt: Date.now() }
  setWaveGate(failed, session.id)
  t.after(() => { clearWaveGate(session.id); clearWaveGate(state.to!) })
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(session.id)?.goalRollover?.phase === 'paused')
  assert.equal((await f.journal.loadGoalRollover(session.id))?.waveGate?.passed, false)
  clearWaveGate(session.id)
  assert.equal(await f.manager.retryGoalRollover(session.id), false)
  assert.equal(f.manager.listSessions().length, 1)
  setWaveGate({ ...failed, passed: true }, session.id)
  assert.equal(await f.manager.retryGoalRollover(session.id), true)
  assert.equal(getWaveGate(state.to!)?.passed, true)
})

test('an invalid checkpoint pauses rather than reserving another successor', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  await f.journal.flush()
  writeFileSync(join(f.journal.dir(session.id), 'goal-rollover.json'), JSON.stringify({ ...state, to: state.from }))
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(session.id)?.goalRollover?.phase === 'paused')
  assert.equal(await f.manager.retryGoalRollover(session.id), false)
  assert.equal(f.manager.listSessions().length, 1)
  assert.match(f.manager.getSession(session.id)!.goalRollover!.error!, /检查点不可用/)
})

test('missing original attachment pauses before successor run acceptance', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  const source = f.manager.getSession(session.id)!
  const raw = (f.manager as unknown as { sessions: Map<string, { record: typeof source }> }).sessions.get(session.id)!.record
  raw.goalInputs = { imageIds: [], documents: [{ id: 'missing', name: 'design.md', bytes: 4, mime: 'text/plain' }] }
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(session.id)?.goalRollover?.phase === 'paused')
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
  assert.match(f.manager.getSession(session.id)!.goalRollover!.error!, /原始文件快照不可用/)
})

test('archiving the source keeps a worktree already referenced by a staged successor', async t => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const f = fixture(t, () => gate)
  const git = (...args: string[]) => execFileSync('git', ['-C', f.cwd, ...args], { stdio: 'pipe', windowsHide: true })
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Goal test'); git('config', 'user.email', 'goal@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(f.cwd, 'seed.md'), 'seed')
  git('add', 'seed.md'); git('commit', '-m', 'test fixture')
  const worktree = join(f.cwd, '..', 'isolated')
  git('worktree', 'add', '-b', 'relay-test', worktree)
  const { session, agent, state } = await begin(f, { cwd: worktree })
  const source = (f.manager as unknown as { sessions: Map<string, { record: typeof session }> }).sessions.get(session.id)!.record
  source.worktreePath = worktree; source.worktreeBranch = 'relay-test'
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(state.to!))
  try {
    assert.equal(f.manager.getSession(state.to!)!.worktreePath, worktree)
    assert.equal(f.manager.archiveSession(session.id), true)
    assert.ok(existsSync(worktree), 'source archival must not remove a successor workspace')
  } finally { release() }
  await f.manager.flushGoalRollover()
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
})

test('shutting down during successor construction prevents late kickoff', async t => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const f = fixture(t, () => gate)
  const { session, agent, state } = await begin(f)
  writeHandoff(state); agent.finish()
  await until(() => f.manager.getSession(state.to!))
  const shuttingDown = f.manager.shutdownAll()
  release(); await shuttingDown
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
  assert.equal(f.manager.getSession(session.id)?.goalRollover?.phase, 'paused')
})

test('a human goal created in the successor while inputs load is never overwritten', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  let release!: () => void, loading = false
  const gate = new Promise<void>(r => { release = r })
  const read = f.manager.getAllEventsAsync.bind(f.manager)
  f.manager.getAllEventsAsync = async id => { if (id === session.id) { loading = true; await gate }; return read(id) }
  writeHandoff(state); agent.finish()
  await until(() => loading)
  const humanGoal = await f.manager.setGoal(state.to!, { goal: 'human replacement', maxIterations: 8, contextWindow: 100_000 })
  release(); await f.manager.flushGoalRollover()
  assert.equal(f.manager.getGoalState(state.to!)?.goalId, humanGoal!.goalId)
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
  assert.equal(f.manager.getSession(session.id)?.goalRollover?.phase, 'paused')
})

test('cancelling the pending successor while inputs load prevents attachment and kickoff', async t => {
  const f = fixture(t)
  const { session, agent, state } = await begin(f)
  let release!: () => void, loading = false
  const gate = new Promise<void>(r => { release = r })
  const read = f.manager.getAllEventsAsync.bind(f.manager)
  f.manager.getAllEventsAsync = async id => { if (id === session.id) { loading = true; await gate }; return read(id) }
  writeHandoff(state); agent.finish()
  await until(() => loading)
  await f.manager.cancelGoal(state.to!)
  release(); await f.manager.flushGoalRollover()
  assert.equal(f.manager.getGoalState(state.to!), null)
  assert.equal(f.agents.get(state.to!)?.prompts.length ?? 0, 0)
  assert.equal(f.manager.getSession(state.to!)?.goalRollover?.phase, 'cancelled')
})
