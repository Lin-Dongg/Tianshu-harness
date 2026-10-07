import { after, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createPersistentTaskState } from '../task-state-persist.js'
import { getEffectiveVerifications } from '../verification-attribution.js'
import { RUN_TESTS_TOOL, parseOutput } from '../../tools/run-tests.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'

const home = mkdtempSync(join(tmpdir(), 'delivery-recovery-'))
process.env.RIVET_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}
function fixture() {
  const cwd = mkdtempSync(join(home, 'repo-'))
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test')
  writeFileSync(join(cwd, 'owned.ts'), 'original'); git(cwd, 'add', '--', 'owned.ts'); git(cwd, 'commit', '-qm', 'initial')
  return { cwd, baseline: { branch: 'main', head: git(cwd, 'rev-parse', 'HEAD'), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() } }
}
it('restores ownership and evidence through the same persistent factory used by desktop assembly', () => {
  const { cwd, baseline } = fixture(), first = createPersistentTaskState(cwd, 'same-session', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  const second = createPersistentTaskState(cwd, 'same-session', { ...baseline, preExistingDirty: ['owned.ts'] })
  assert.equal(second.recovery, 'restored'); assert.equal(second.ownership.isOwned('owned.ts'), true)
  assert.equal(second.taskLedger.getVerificationStatus(), 'verified')
  const gate = createDeliveryGateV2({ taskLedger: second.taskLedger, ownership: second.ownership, attribution: createVerificationAttribution({ ownership: second.ownership }) })
  assert.equal(gate.getReport([], ['owned.ts']).state, 'GREEN')
  writeFileSync(join(cwd, 'owned.ts'), 'external edit')
  const third = createPersistentTaskState(cwd, 'same-session', baseline)
  assert.equal(third.recovery, 'verification_stale'); assert.equal(third.ownership.isOwned('owned.ts'), true)
  assert.equal(third.taskLedger.getVerificationStatus(), 'unverified')
})
it('changed index, changed HEAD and missing snapshots never reuse verified evidence', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'version-test', baseline)
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  writeFileSync(join(cwd, 'external.ts'), 'peer'); git(cwd, 'add', '--', 'external.ts')
  assert.equal(createPersistentTaskState(cwd, 'version-test', baseline).recovery, 'verification_stale')
  git(cwd, 'commit', '-qm', 'peer')
  assert.equal(createPersistentTaskState(cwd, 'version-test', baseline).recovery, 'verification_stale')
  const old = createPersistentTaskState(cwd, 'old-session', baseline)
  assert.equal(old.recovery, 'baseline_missing'); assert.equal(old.ownership.isOwned('external.ts'), false)
})
it('new edits invalidate earlier evidence without clearing file provenance', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'edit-test', baseline)
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  writeFileSync(join(cwd, 'owned.ts'), 'next edit'); state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0)
  assert.equal(state.ownership.isOwned('owned.ts'), true)
})
it('isolated failure and integration success cannot supersede one another', () => {
  const result = getEffectiveVerifications([
    { type: 'verification', timestamp: 1, command: 'npm test', status: 'failed', meta: { scope: 'full', verificationPhase: 'isolated', snapshotRef: 'same' } },
    { type: 'verification', timestamp: 2, command: 'npm test', status: 'passed', meta: { scope: 'full', verificationPhase: 'integration', snapshotRef: 'same' } },
  ])
  assert.equal(result.effective.length, 2); assert.equal(result.supersededFailures, 0)
})
it('parses later failing batches instead of reporting the first batch as zero failures', () => {
  const parsed = parseOutput('ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ tests 3\nℹ pass 2\nℹ fail 1\n', 'node-test')
  assert.equal(parsed.passed, 4); assert.equal(parsed.failed, 1)
  assert.equal(parseOutput('ℹ tests 2\nℹ pass 2\nℹ fail 0\n✖ actual failure\n', 'node-test').countsReliable, false)
})
it('real run_tests isolated failure skips integration and never claims isolation passed', async () => {
  const cwd = mkdtempSync(join(home, 'tests-')), isolated = mkdtempSync(join(home, 'snapshot-'))
  for (const root of [cwd, isolated]) {
    mkdirSync(join(root, 'test'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/example.test.js' } }))
    writeFileSync(join(root, 'test/example.test.js'), "require('node:test')('failure', () => { throw new Error('actual failure') })")
  }
  const result = await RUN_TESTS_TOOL.execute({ cwd, toolUseId: 'two-phase', input: {}, verificationSnapshot: { path: isolated, snapshotRef: 'version' } })
  assert.equal(result.isError, true); assert.doesNotMatch(result.content, /隔离环境已通过/)
  assert.equal(result.verification?.status, 'failed')
  assert.equal(result.extraVerifications, undefined)
  assert.match(result.content, /跳过/)
  assert.match(readFileSync(result.rawPath!, 'utf8'), /actual failure/)
})

it('external live edits stale evidence before delivery without waiting for a rebuild', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'live-check', baseline)
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  writeFileSync(join(cwd, 'owned.ts'), 'peer changed the file')
  assert.equal(state.taskLedger.getVerificationStatus(), 'unverified')
  assert.equal(state.ownership.isOwned('owned.ts'), true)
})
it('the desktop assembly path consumes persistent stores and preserves session identity', () => {
  const bootstrap = readFileSync(join(process.cwd(), 'src/bootstrap.ts'), 'utf8')
  const sidecar = readFileSync(join(process.cwd(), 'src/server/serve-agent.ts'), 'utf8')
  assert.match(bootstrap, /createPersistentTaskState\(cwd, refs\.sessionId/)
  assert.match(bootstrap, /refs\.taskLedger = b1TaskLedger/)
  assert.match(sidecar, /createInteractiveToolRegistry\(refs, ctx\.config, cwd\)/)
})
