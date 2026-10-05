import { basename } from 'node:path'
import { classifyVerificationCommand, verificationArgv } from '../tools/verification-command.js'
import { applyBatchCounts, type TestCounts } from '../tools/test-output-counts.js'
import type { ToolResult, VerificationMetadata } from '../tools/types.js'

/** This parser only classifies an already executed command; it never executes it. */
export function inferBashVerificationScope(command: string): Pick<VerificationMetadata, 'scope' | 'targetFiles' | 'kind'> {
  const tokens = verificationArgv(command)
  if (!tokens) return { scope: 'unknown' }
  const invocationInfo = classifyVerificationCommand(command)
  if (invocationInfo.nodeTest || invocationInfo.batchRunner) {
    return { kind: 'test', scope: invocationInfo.filtered ? 'unknown' : invocationInfo.targets.length ? 'targeted' : 'full', ...(invocationInfo.targets.length ? { targetFiles: invocationInfo.targets } : {}) }
  }
  if (tokens[0] === 'rtk') { tokens.shift(); if (String(tokens[0]) === 'proxy') tokens.shift() }
  if (tokens[0] === 'rtk') return { scope: 'unknown' }
  const executable = basename((tokens[0] ?? '').replaceAll('\\', '/')).replace(/\.(?:exe|cmd)$/i, '')
  const args = tokens.slice(1)
  const invocation = [executable, ...args].join(' ')
  const kind: VerificationMetadata['kind'] =
    /^(?:(?:npm|pnpm|yarn) (?:test|run test)|(?:npx )?(?:(?:node|tsx) --test|vitest(?: run)?|jest|pytest)|cargo test|go test)(?:\s|$)/.test(invocation) ? 'test'
    : /^(?:(?:npm|pnpm|yarn) run typecheck|(?:npx )?tsc)(?:\s|$)/.test(invocation) ? 'typecheck'
    : /^(?:(?:npm|pnpm|yarn) run lint|(?:npx )?eslint)(?:\s|$)/.test(invocation) ? 'lint'
    : /^(?:(?:npm|pnpm|yarn) run build|go build)(?:\s|$)/.test(invocation) ? 'build'
    : /^(?:cargo check|go vet)(?:\s|$)/.test(invocation) ? 'check' : undefined
  // A name/tag selector proves only a subset within each selected file.
  if (kind === 'test' && /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--grep|-t|-k|-m)(?:[=\s]|$)/.test(invocation)) {
    return { scope: 'unknown', kind }
  }
  const targetFiles = [...new Set(args.filter(arg => !arg.startsWith('-')
    && /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|sh)$/.test(arg)))]
  if (targetFiles.length > 0) return { scope: kind ? 'targeted' : 'unknown', targetFiles, ...(kind ? { kind } : {}) }

  // Full describes an unfiltered invocation, not proof of every suite's
  // coverage. Unknown scripts and selectors retain unknown scope.
  if (/^(?:npm|pnpm|yarn) (?:test|run test)$/.test(invocation)
    || /^(?:node|tsx) --test$/.test(invocation)
    || /^(?:npx )?(?:vitest(?: run)?|jest|pytest)$/.test(invocation)
    || /^(?:cargo test|go test \.\/\.\.\.)$/.test(invocation)) return { scope: 'full', kind: 'test' }
  if (/^(?:npm|pnpm|yarn) run typecheck$/.test(invocation)
    || /^(?:npx )?tsc(?: --noEmit)?$/.test(invocation)) return { scope: 'full', kind: 'typecheck' }
  if (/^(?:npm|pnpm|yarn) run lint$/.test(invocation)) return { scope: 'full', kind: 'lint' }
  if (/^(?:npm|pnpm|yarn) run build$/.test(invocation)
    || /^go build \.\/\.\.\.$/.test(invocation)) return { scope: 'full', kind: 'build' }
  if (/^(?:cargo check|go vet \.\/\.\.\.)$/.test(invocation)) return { scope: 'full', kind: 'check' }
  return { scope: 'unknown' }
}

function count(output: string, pattern: RegExp): number {
  const match = output.match(pattern)
  return match ? Number.parseInt(match.slice(1).find(value => value !== undefined) ?? '0', 10) : 0
}

export function buildBashVerification(
  command: string,
  result: ToolResult | undefined,
  outcome: { content: string; isError: boolean; errorClass?: string },
): VerificationMetadata {
  const output = outcome.content
  let passed = count(output, /(?:ℹ|#)\s+pass\s+(\d+)|✅\s+(\d+)\s+passed|Tests?\s+(\d+)\s+passed/i)
  let failed = count(output, /(?:ℹ|#)\s+fail\s+(\d+)|❌\s+(\d+)\s+failed|Tests?\s+(\d+)\s+failed/i)
  let skipped = count(output, /(?:ℹ|#)\s+(?:skip|skipped)\s+(\d+)/i)
  const exitCode = typeof result?.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : undefined
  const errorClass = result?.errorClass ?? (outcome.isError ? outcome.errorClass : undefined)
  const timedOut = errorClass === 'timeout' || /timed out after \d+s/i.test(output)
  const counts: TestCounts = { passed, failed, skipped, exitCode: exitCode ?? -1, failures: [] }
  applyBatchCounts(output, counts)
  ;({ passed, failed, skipped } = counts)
  const scope = result?.verification?.coverage
    ? { kind: 'test' as const, scope: result.verification.scope, targetFiles: result.verification.targetFiles ?? inferBashVerificationScope(command).targetFiles }
    : inferBashVerificationScope(command)
  const status = outcome.isError || result?.isError || timedOut || failed > 0 || (exitCode !== undefined && exitCode !== 0)
    ? 'failed' : exitCode === 0 && scope.scope !== 'unknown' ? 'passed' : 'blocked'
  const failureKind = timedOut ? 'timeout'
    : status === 'failed' && (errorClass === 'environment' || errorClass === 'exec-failure') ? 'tool_invocation_failure'
    : status === 'failed' && exitCode !== undefined && result?.isError === false ? 'test_failure'
    : undefined
  return {
    command, status, ...scope, passed, failed, skipped, countsReliable: counts.countsReliable,
    ...(result?.verification?.coverage ? { coverage: result.verification.coverage } : {}),
    ...(status === 'blocked' || scope.kind === 'test' && !result?.verification?.coverage?.complete ? { userGuidance: classifyVerificationCommand(command).reason ?? '缺少完整逐文件完成证明；请用支持的运行器重新验证。' } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failureKind ? { failureKind } : {}),
  }
}
