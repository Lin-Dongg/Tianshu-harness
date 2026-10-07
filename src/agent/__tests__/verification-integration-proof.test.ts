import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVerificationSnapshot } from '../verification-snapshot.js'
import { RUN_TESTS_TOOL } from '../../tools/run-tests.js'
import { createPersistentTaskState } from '../task-state-persist.js'
import { createVerificationRecorder } from '../verification-recorder.js'
import { createVerificationAttribution, getEffectiveVerifications } from '../verification-attribution.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { EvidenceTracker } from '../evidence.js'
import { createTaskLedger } from '../task-ledger.js'

it('real snapshot proofs cover the source repository and integration differences do not become RED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'verification integration '))
  const previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, '.state')
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  let snapshot: Awaited<ReturnType<typeof createVerificationSnapshot>> | undefined
  try {
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n.rivet\n.state\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'tsx --test' } }))
    symlinkSync(join(import.meta.dirname, '../../../node_modules'), join(cwd, 'node_modules'), 'junction')
    writeFileSync(join(cwd, 'src/feature.ts'), 'export const value = 1;')
    writeFileSync(join(cwd, 'src/external.ts'), 'export const external = 1;')
    const test = (expected: number) => `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './feature.ts'; import {external} from './external.ts'; test('owned',()=>assert.equal(value,${expected})); test('integration',()=>assert.equal(external,1));`
    writeFileSync(join(cwd, 'src/feature.test.ts'), test(1))
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base')
    const head = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'src/feature.ts'), 'export const value = 2;')
    writeFileSync(join(cwd, 'src/feature.test.ts'), test(2))
    writeFileSync(join(cwd, 'src/external.ts'), 'export const external = 3;')
    const baseline = { branch: 'main', head, preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
    const state = createPersistentTaskState(cwd, 'proof', baseline)
    for (const path of ['src/feature.ts', 'src/feature.test.ts']) state.taskLedger.record({ type: 'file_write', path })
    snapshot = await createVerificationSnapshot({ baseCwd: cwd, sessionId: 'proof', baselineHead: head, ownedFiles: ['src/feature.ts', 'src/feature.test.ts'] })
    const recorder = createVerificationRecorder({ taskLedger: state.taskLedger, evidence: new EvidenceTracker() })
    const result = await RUN_TESTS_TOOL.execute({ input: { filter: 'src/feature.test.ts' }, toolUseId: 'proof', cwd, verificationSnapshot: { path: snapshot.path, snapshotRef: 'version', repositoryRoot: cwd } })
    assert.equal(result.verification?.coverage?.complete, true, result.content)
    assert.equal(result.verification?.coverage?.repositoryRoot, realpathSync(cwd))
    assert.equal(result.verification?.coverage?.executionRoot, realpathSync(snapshot.path))
    assert.equal(result.extraVerifications?.[0]?.status, 'failed')
    recorder(result.verification!)
    recorder(result.extraVerifications![0])
    const gate = createDeliveryGateV2({ taskLedger: state.taskLedger, ownership: state.ownership, attribution: createVerificationAttribution({ ownership: state.ownership }) })
    const coverage = { impactedTests: ['src/feature.test.ts'], repositoryRoot: cwd, testExists: () => true }
    state.ownership.autoOwnFromLedger()
    const dirty = ['src/feature.ts', 'src/feature.test.ts', 'src/external.ts']
    const assessed = gate.assess([], dirty, 'version', coverage)
    assert.equal(assessed.state, 'YELLOW', JSON.stringify(assessed))
    assert.equal(assessed.isBlocked, false)
    const a = result.verification!, b = result.extraVerifications![0]
    const obsolete = new EvidenceTracker()
    const checkSnapshot = createVerificationRecorder({ taskLedger: state.taskLedger, evidence: obsolete })
    writeFileSync(join(snapshot.path, 'src/feature.ts'), 'export const value = 99;')
    checkSnapshot({ ...a, executionId: 'obsolete-snapshot' })
    assert.equal(obsolete.getState().verifications.at(-1)?.stale, true, 'actual snapshot content must match the captured owned version')
    writeFileSync(join(snapshot.path, 'src/feature.ts'), 'export const value = 2;')
    const comparisonGate = createDeliveryGateV2({ taskLedger: createTaskLedger({ taskId: 'comparison' }), ownership: state.ownership, attribution: createVerificationAttribution({ ownership: state.ownership }) })
    for (const altered of [{ ...a, stale: true }, { ...a, comparisonId: 'wrong' }, { ...a, snapshotRef: 'wrong' }, { ...a, command: 'different' }, { ...a, coverage: { ...a.coverage!, complete: false } }]) {
      assert.equal(comparisonGate.assess([altered, b], dirty, 'version', coverage).state, 'RED')
    }
    const restored = createPersistentTaskState(cwd, 'proof', baseline)
    assert.equal(getEffectiveVerifications(restored.taskLedger.getVerifications()).effective.length, 2)
    git('add', 'src/external.ts'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'peer')
    assert.equal(getEffectiveVerifications(restored.taskLedger.getVerifications()).effective.filter(v => v.verificationPhase === 'isolated').length, 1, 'peer HEAD must not invalidate owned snapshot')
    writeFileSync(join(cwd, 'src/feature.ts'), 'export const value = 4;')
    assert.equal(getEffectiveVerifications(restored.taskLedger.getVerifications()).effective.length, 0, 'owned edits invalidate both proofs')
  } finally {
    snapshot?.destroy()
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous
    rmSync(cwd, { recursive: true, force: true })
  }
})
