import { randomUUID } from 'node:crypto'
import { buildBashVerification, inferBashVerificationScope, isVerificationCommand, suggestSingleCommand } from '../agent/bash-verification.js'
import { completionFacts } from './verification-facts.js'
import { prepareCompletionCapture } from './test-completion.js'
import type { JobSpawnOptions } from './job-store.js'
import type { ToolCallParams } from './types.js'
import { getShellCommand } from '../platform.js'
import { classifyDeclaredCommand, loadDeclaredVerify } from '../config/verify-config.js'
import { unwrapVerification } from './verification-invocation.js'

export function prepareBackgroundVerification(command: string, params: ToolCallParams): {
  command: string; env: NodeJS.ProcessEnv; onCompleted: JobSpawnOptions['onCompleted']; note: string; dispose(): void
} {
  const capture = prepareCompletionCapture(command, params.cwd, getShellCommand().kind)
  const startedAt = Date.now(), executionId = randomUUID()
  const leaf = unwrapVerification(command, params.cwd)
  const kind = classifyDeclaredCommand(leaf?.command ?? command, loadDeclaredVerify(leaf?.cwd ?? params.cwd)) ?? inferBashVerificationScope(command)?.kind
  const verificationCommand = !!kind || isVerificationCommand(command)
  const suggestion = verificationCommand ? suggestSingleCommand(command) : null
  let recorded = false
  return {
    command: capture?.command ?? command, env: capture?.env ?? {},
    dispose: () => capture?.dispose(),
    note: !verificationCommand ? '' : capture || kind && kind !== 'test'
      ? '\n验证运行中，完成后自动记录；启动或输出命中不代表验证通过。'
      : `\n无法自动获取完整证明，请用独立命令或 run_tests；退出结果会保留，日志尾部不能补齐覆盖。${suggestion ? `\n可复制的单条命令：${suggestion}` : ''}`,
    onCompleted({ job, output, error, timedOut }) {
      if (recorded) return
      recorded = true
      try {
        if (!verificationCommand) return
        const exitCode = timedOut ? -1 : job.exitCode
        const coverage = capture?.read(exitCode ?? -1)
        const stopped = job.status === 'killed'
        if (stopped && coverage) { coverage.complete = false; coverage.executionComplete = false }
        const result = { content: output, exitCode, isError: !!error || stopped || timedOut, errorClass: timedOut ? 'timeout' as const : error ? 'environment' as const : undefined }
        const verification = buildBashVerification(command, result, { content: output, isError: result.isError, errorClass: result.errorClass })
        if (kind || coverage) verification.status = exitCode === 0 && !result.isError ? 'passed' : 'failed'
        if (kind) verification.kind = kind
        if (verification.status === 'passed') delete verification.failureKind
        Object.assign(verification, completionFacts(coverage), { executionId: coverage?.runId ?? executionId, timestamp: startedAt, durationMs: (job.endedAt ?? Date.now()) - startedAt })
        if (coverage?.complete) delete verification.userGuidance
        if (kind === 'test' && !coverage) verification.countsReliable = false
        if (kind !== 'test') { delete verification.passed; delete verification.failed; delete verification.skipped; delete verification.countsReliable }
        if (stopped) verification.userGuidance = timedOut ? '后台验证超时并已终止；未取得完整覆盖证明。' : '后台验证已终止；未取得完整覆盖证明。'
        params.onVerificationCompleted?.(verification)
      } finally { capture?.dispose() }
    },
  }
}
