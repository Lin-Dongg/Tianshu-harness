import type { TestCompletionCoverage, VerificationMetadata } from './types.js'

export function completionFacts(coverage?: TestCompletionCoverage): Partial<VerificationMetadata> {
  if (!coverage) return {}
  return {
    coverage, executionId: coverage.runId,
    stale: coverage.workspaceChanged === true,
    ...(coverage.totals ? { passed: coverage.totals.passed, failed: coverage.totals.failed, skipped: coverage.totals.skipped } : {}),
    countsReliable: coverage.executionComplete === true && !!coverage.totals,
  }
}

export function verificationMeta(v: VerificationMetadata, includeResolved = false): Record<string, unknown> {
  const { command, status: _status, ...meta } = v
  return { ...meta, ...(includeResolved ? { resolvedCommand: command, recommendedCommand: v.recommendedCommand ?? command } : {}) }
}
