import type { VerificationMetadata } from '../tools/types.js'
import { readCompletionCoverage } from '../tools/test-completion.js'

/** The integration flag alone is not proof. Both executions must survive validation. */
export function hasIsolatedComparison(result: VerificationMetadata, verifications: readonly VerificationMetadata[]): boolean {
  const b = readCompletionCoverage(result.coverage)
  if (result.stale || result.status !== 'failed' || result.kind !== 'test' || result.verificationPhase !== 'integration'
    || !result.comparisonId || !result.snapshotRef || result.failureKind === 'timeout' || result.failureKind === 'tool_invocation_failure'
    || !b || b.workspaceChanged || b.filtered || b.executionComplete !== true) return false
  return verifications.some(a => {
    const c = readCompletionCoverage(a.coverage)
    return !a.stale && a.status === 'passed' && a.exitCode === 0 && a.kind === 'test' && a.verificationPhase === 'isolated'
      && a.comparisonId === result.comparisonId && a.snapshotRef === result.snapshotRef && a.scope === result.scope
      && a.command === result.command && !!c?.complete && !c.filtered && !c.workspaceChanged
      && c.repositoryRoot === b.repositoryRoot && c.files.length === b.files.length
      && b.files.every(f => c.files.some(p => p.path === f.path && p.outcome === 'passed' && p.tests > p.skipped && p.cancelled === 0))
  })
}
