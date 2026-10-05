import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createPersistentTaskState } from '../task-state-persist.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createDeliverTaskTool } from '../deliver-task.js'
import { assessImpactedTestCoverage, createVerificationAttribution, getEffectiveVerifications } from '../verification-attribution.js'
import { isTransientPlanDraftPath } from '../plan-mode.js'
import { runVerification } from './helpers/verification-pipeline-fixture.js'

const impacted = ['src/__tests__/consumer.test.ts']

function context() {
  const ledger = createTaskLedger({ taskId: 'p1-regression' })
  ledger.record({ type: 'file_write', path: 'feature.js' })
  const ownership = createOwnershipLedger({
    baseline: createWorktreeBaseline({ branch: 'main', head: 'fixture', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }),
    taskLedger: ledger,
  })
  ownership.autoOwnFromLedger()
  const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
  return { ledger, ownership, deliveryGate: gate }
}

async function commit(ctx: ReturnType<typeof context>, cwd: string, impactedTests: string[], force = false) {
  let calls = 0
  const tool = createDeliverTaskTool(() => ({
    taskLedger: ctx.ledger, ownership: ctx.ownership, gate: ctx.deliveryGate,
    getCurrentDirtyFiles: () => ['feature.js'], getImpactedTests: () => impactedTests,
    detectWroteButNeverRead: () => [],
    commitOwnedFiles: () => { calls++; return { ok: true, output: 'mock scoped commit' } },
  }))
  const result = await tool.execute({ cwd, toolUseId: 'p1-commit', input: { commit: true, message: 'fix: fixture', force } })
  return { calls, result }
}

async function withWorkspace(run: (cwd: string) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-p1-'))
  try { await run(cwd) } finally { rmSync(cwd, { recursive: true, force: true }) }
}

function file(cwd: string, path: string) {
  const full = join(cwd, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, '// fixture\n')
}

for (const kind of ['typecheck', 'lint', 'build'] as const) {
  it(`P1: actual full ${kind} preserves kind through ledger and cannot commit untested changes`, async () => {
    const pipeline = await runVerification(`npm run ${kind}`, false)
    assert.equal(pipeline.actual.exitCode, 0)
    assert.equal(pipeline.ledgerEvent.meta?.kind, kind)
    assert.equal(getEffectiveVerifications(pipeline.ledger.getVerifications()).effective[0]?.kind, kind)
    await withWorkspace(async cwd => {
      file(cwd, impacted[0]!)
      const result = await commit(pipeline, cwd, impacted, true)
      assert.equal(result.calls, 0)
      assert.equal(result.result.errorKind, 'delivery_gate')
    })
  })
}

it('P1: actual targeted lint cannot supply runtime test coverage', async () => {
  const pipeline = await runVerification('npm run lint -- good.test.mjs', false)
  const effective = getEffectiveVerifications(pipeline.ledger.getVerifications()).effective
  assert.equal(effective[0]?.kind, 'lint')
  assert.deepEqual(assessImpactedTestCoverage(['good.test.mjs'], effective, () => true).uncovered, ['good.test.mjs'])
})

it('P1: a name-filtered bash run cannot attest to complete file coverage', async () => {
  const pipeline = await runVerification('node --test --test-name-pattern=absent good.test.mjs', false)
  assert.equal(pipeline.actual.exitCode, 0)
  const effective = getEffectiveVerifications(pipeline.ledger.getVerifications()).effective
  assert.equal(effective[0]?.scope, 'unknown')
  assert.notEqual(effective[0]?.status, 'passed')
  assert.deepEqual(assessImpactedTestCoverage(['good.test.mjs'], effective, () => true).uncovered, ['good.test.mjs'])
})

it('P1: real run_tests stamps test kind and retains targeted coverage through ledger', async () => {
  const pipeline = await runVerification('good.test.mjs', false, false, { tool: 'run_tests' })
  assert.equal(pipeline.actual.verification?.kind, 'test')
  const effective = getEffectiveVerifications(pipeline.ledger.getVerifications()).effective
  assert.equal(effective[0]?.kind, 'test')
  assert.deepEqual(assessImpactedTestCoverage(['good.test.mjs', 'bad.test.mjs'], effective, () => true), {
    uncovered: ['bad.test.mjs'], uncoverable: [],
  })
})

it('P1: absent/invalid kind and full label without file scope cannot manufacture coverage', () => {
  for (const kind of [undefined, 'test', 'typecheck', 'lint', 'build', 'check'] as const) {
    const coverage = assessImpactedTestCoverage(impacted, [{ command: 'npm test', status: 'passed', scope: 'full', kind }], () => true)
    assert.deepEqual(coverage.uncovered, impacted)
  }
  const ctx = context()
  ctx.ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', kind: 'bogus', targetFiles: impacted } })
  const effective = getEffectiveVerifications(ctx.ledger.getVerifications()).effective
  assert.equal(effective[0]?.kind, undefined)
  assert.deepEqual(assessImpactedTestCoverage(impacted, effective, () => true).uncovered, impacted)
})

it('P1: test failure cannot be superseded by a lint result for the same selected files', () => {
  const ctx = context()
  for (const [kind, status] of [['test', 'failed'], ['lint', 'passed']] as const) {
    ctx.ledger.record({ type: 'verification', command: 'npm run verify', status, meta: { scope: 'targeted', kind, targetFiles: impacted } })
  }
  const effective = getEffectiveVerifications(ctx.ledger.getVerifications()).effective
  assert.equal(effective.length, 2)
  assert.ok(effective.some(v => v.kind === 'test' && v.status === 'failed'))
})

for (const blockedReason of ['no_test_framework', 'no_tests_found'] as const) {
  it(`P1: ${blockedReason} cannot cancel an existing impacted-test obligation or allow commit`, async () => {
    await withWorkspace(async cwd => {
      file(cwd, impacted[0]!)
      const ctx = context()
      ctx.ledger.record({ type: 'verification', command: 'node --test other.test.js', status: 'passed', meta: { scope: 'targeted', kind: 'test', targetFiles: ['other.test.js'] } })
      assert.equal((await commit(ctx, cwd, impacted)).calls, 0)
      ctx.ledger.record({ type: 'verification', command: 'run_tests', status: 'blocked', meta: { scope: 'full', kind: 'test', blockedReason } })
      const after = await commit(ctx, cwd, impacted, true)
      assert.equal(after.calls, 0)
      assert.equal(after.result.errorKind, 'delivery_gate')
      assert.match(after.result.content, /consumer\.test\.ts/)
    })
  })
}

it('P1: actual blocked run_tests remains blocked, and its missing-infrastructure result does not waive coverage', async () => {
  const pipeline = await runVerification('', false, false, { tool: 'run_tests', noTestInfra: true })
  assert.equal(pipeline.actual.verification?.status, 'blocked')
  assert.equal(pipeline.ledgerEvent.status, 'blocked')
  assert.equal(getEffectiveVerifications(pipeline.ledger.getVerifications()).effective[0]?.blockedReason, 'no_test_framework')
  pipeline.ledger.record({ type: 'verification', command: 'node --test other.test.js', status: 'passed', meta: { scope: 'targeted', kind: 'test', targetFiles: ['other.test.js'] } })
  await withWorkspace(async cwd => {
    file(cwd, impacted[0]!)
    assert.equal((await commit(pipeline, cwd, impacted, true)).calls, 0)
  })
})

for (const path of ['tests/test_consumer.py', 'desktop/scripts/__tests__/consumer.test.ts', 'tests/consumer.test.js']) {
  it(`P1: existing ${path} stays uncovered until an explicit test run covers it`, async () => {
    await withWorkspace(async cwd => {
      file(cwd, path)
      const ctx = context()
      ctx.ledger.record({ type: 'verification', command: 'node --test src/other.test.ts', status: 'passed', meta: { scope: 'targeted', kind: 'test', targetFiles: ['src/other.test.ts'] } })
      const blocked = await commit(ctx, cwd, [path], true)
      assert.equal(blocked.calls, 0)
      assert.match(blocked.result.content, /impacted tests/)
      ctx.ledger.record({ type: 'verification', command: `test ${path}`, status: 'passed', meta: { scope: 'targeted', kind: 'test', targetFiles: [path] } })
      assert.equal((await commit(ctx, cwd, [path])).calls, 1, 'a supported targeted runner can discharge this obligation')
    })
  })
}

it('P1: a successful root full run cannot silently cover a different suite', async () => {
  await withWorkspace(async cwd => {
    const path = 'desktop/scripts/__tests__/consumer.test.ts'
    file(cwd, path)
    const ctx = context()
    ctx.ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', kind: 'test' } })
    assert.equal((await commit(ctx, cwd, [path])).calls, 0)
  })
})

it('P1: only the normalized repository plan-draft path gets the transient exemption', () => {
  assert.equal(isTransientPlanDraftPath('.rivet/plans/draft-123.md'), true)
  assert.equal(isTransientPlanDraftPath('.\\.rivet\\plans\\draft-123.md'), true)
  assert.equal(isTransientPlanDraftPath('/repo/.rivet/plans/draft-123.md', '/repo'), true)
  assert.equal(isTransientPlanDraftPath('/other/.rivet/plans/draft-123.md', '/repo'), false)
  assert.equal(isTransientPlanDraftPath('C:\\repo\\.rivet\\plans\\draft-123.md', 'c:\\repo'), true)
  assert.equal(isTransientPlanDraftPath('C:\\other\\.rivet\\plans\\draft-123.md', 'C:\\repo'), false)
  assert.equal(isTransientPlanDraftPath('/repo/.rivet/plans/draft-123.md'), false)
  for (const path of ['src/prompts/draft-123.md', 'docs/draft-123.md', '.rivet/plans/nested/draft-123.md', '.rivet/plans/../draft-123.md', '../.rivet/plans/draft-123.md']) {
    assert.equal(isTransientPlanDraftPath(path), false, path)
  }
})

it('P1: ordinary draft-named prompt edits invalidate persisted verification, including external writes', async () => {
  await withWorkspace(async cwd => {
    const previousHome = process.env.RIVET_HOME
    process.env.RIVET_HOME = join(cwd, 'home')
    try {
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        return result.stdout.trim()
      }
      git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
      const path = 'src/prompts/draft-123.md'
      file(cwd, path); git('add', '--', path); git('commit', '-qm', 'fixture')
      const baseline = { branch: 'main', head: git('rev-parse', 'HEAD'), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
      for (const external of [false, true]) {
        const state = createPersistentTaskState(cwd, `prompt-${external}`, baseline)
        state.taskLedger.record({ type: 'file_write', path })
        state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', kind: 'test' } })
        assert.equal(state.taskLedger.getVerificationStatus(), 'verified')
        writeFileSync(join(cwd, path), `changed ${external}`)
        if (!external) state.taskLedger.record({ type: 'file_write', path })
        assert.equal(state.taskLedger.getVerificationStatus(), 'unverified')
        const restored = createPersistentTaskState(cwd, `prompt-${external}`, baseline)
        assert.equal(getEffectiveVerifications(restored.taskLedger.getVerifications()).effective.length, 0)
      }
    } finally {
      if (previousHome === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = previousHome
    }
  })
})
