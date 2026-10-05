import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL } from '../../../tools/run-tests.js'
import { BASH_TOOL } from '../../../tools/bash.js'
import { ToolRegistry } from '../../../tools/registry.js'
import type { ToolResult } from '../../../tools/types.js'
import { executeToolUse, type ToolPipelineDeps } from '../../tool-pipeline.js'
import { EvidenceTracker } from '../../evidence.js'
import { TurnHarness } from '../../turn-harness.js'
import { TrajectoryRecorder } from '../../trajectory.js'
import { createTaskLedger } from '../../task-ledger.js'
import { createOwnershipLedger } from '../../ownership-ledger.js'
import { createWorktreeBaseline } from '../../worktree-baseline.js'
import { createVerificationAttribution } from '../../verification-attribution.js'
import { createDeliveryGateV2 } from '../../delivery-gate-v2.js'
import { createTurnBudget } from '../../turn-budget.js'
import { observeRun } from '../../stall-observer.js'

export async function runVerification(command: string, failTest: boolean, ownFailingTest = false, options: { tool?: 'bash' | 'run_tests'; noTestInfra?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rivet-bash-evidence-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = join(root, 'rivet-home')
  mkdirSync(process.env.RIVET_HOME)
  writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
  try {
    if (!options.noTestInfra) writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test', typecheck: 'node -e \"process.exit(0)\"', lint: 'node -e \"process.exit(0)\"', build: 'node -e \"process.exit(0)\"' } }))
    writeFileSync(join(cwd, 'good.test.mjs'), "import { test } from 'node:test'; test('passing fixture', () => {});\n")
    writeFileSync(join(cwd, 'bad.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('fixture assertion', () => assert.equal(1, ${failTest ? 2 : 1}));\n`)
    const ledger = createTaskLedger({ taskId: 'bash-evidence-test' })
    ledger.record({ type: 'file_write', path: 'feature.js' })
    if (ownFailingTest) ledger.record({ type: 'file_write', path: 'bad.test.mjs' })
    const baseline = createWorktreeBaseline({ branch: 'fixture', head: 'fixture-head', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    const evidence = new EvidenceTracker()
    evidence.trackFileModified('feature.js')
    let actual: ToolResult | undefined
    const registry = new ToolRegistry()
    const tool = options.tool === 'run_tests' ? RUN_TESTS_TOOL : BASH_TOOL
    registry.register({ ...tool, execute: async params => { actual = await tool.execute(params); return actual } })
    const trajectory = new TrajectoryRecorder()
    const deps = {
      config: {
        toolRegistry: registry, hooks: null, lspEnabled: false, sessionId: 'bash-evidence-test',
        approvalMode: 'dangerously-skip-permissions',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'fixture-model' },
      },
      cwd, harness: new TurnHarness({ maxRetries: 0, retryableClasses: [] }, trajectory),
      prewarm: { get: () => null, invalidate: () => {} }, evidence,
      traceStore: { events: [], toolFingerprints: [] },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: unknown) => ({ output: input, telemetry: [] }) },
      importGraph: null, lastConflictCheckCount: 0, trajectory,
      getDoomLoopLevel: () => 'none', latestRisk: { level: 'none', reasons: [], suggestedAction: '' },
      sessionTurnCount: 1, sessionId: 'bash-evidence-test', recordToolHistory: () => {},
      turnBudget: createTurnBudget(0), taskLedger: ledger, ownershipLedger: ownership,
    } as unknown as ToolPipelineDeps
    const callbacks = {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: () => {},
      onTurnComplete: () => {}, onError: () => {}, onAbort: () => {},
      onApprovalRequired: async () => true, onCheckpoint: () => {},
    }
    await observeRun('bash-evidence-test', () => executeToolUse(
      { id: 'real-bash-verification', name: tool.definition.name, input: options.tool === 'run_tests' ? (command ? { filter: command } : {}) : { command } }, deps, callbacks, 1, false,
    ))
    const verification = evidence.getState().verifications.at(-1)!
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
    return { actual: actual!, verification, ledgerEvent: ledger.getVerifications().at(-1)!, gate: gate.assess([]), deliveryGate: gate, ledger, ownership }
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}
