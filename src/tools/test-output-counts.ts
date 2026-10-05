export interface TestCounts {
  exitCode: number
  passed: number
  failed: number
  skipped: number
  failures: unknown[]
  countsReliable?: boolean
}

export function applyBatchCounts(clean: string, result: TestCounts): void {
  const passes = [...clean.matchAll(/^[ℹ#]\s+pass\s+(\d+)\s*$/gm)]
  const fails = [...clean.matchAll(/^[ℹ#]\s+fail\s+(\d+)\s*$/gm)]
  if (passes.length && passes.length === fails.length) {
    result.passed = passes.reduce((sum, match) => sum + Number(match[1]), 0)
    result.failed = fails.reduce((sum, match) => sum + Number(match[1]), 0)
    result.skipped = [...clean.matchAll(/^[ℹ#]\s+(?:skip|skipped)\s+(\d+)\s*$/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
  }
  result.countsReliable = result.passed + result.failed + result.skipped > 0
    && !(result.failures.length > 0 && result.failed === 0)
}

export function formatTestCounts(result: TestCounts): string {
  return result.countsReliable === false || (result.exitCode !== 0 && result.failed === 0)
    ? `${result.passed} 通过，失败数量未确认，${result.skipped} 跳过`
    : `${result.passed} 通过，${result.failed} 失败，${result.skipped} 跳过`
}
