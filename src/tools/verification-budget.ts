import type { ToolCallParams, ToolResult } from './types.js'
import type { RunnableTestCommand } from './run-tests.js'

export function verificationTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 120_000
}

export function runTestsTimeoutMs(params?: ToolCallParams): number {
  return verificationTimeout(params?.input.timeout) + 5_000
}

export function verificationBudgetStop(command: RunnableTestCommand, startedAt: number, reason: 'timeout' | 'cancelled'): ToolResult {
  const content = reason === 'timeout' ? '验证总预算已耗尽，未启动后续阶段。' : '测试已被用户中止，未取得完整验证证据。'
  return {
    content, isError: true, ...(reason === 'timeout' ? { errorKind: 'timeout' as const } : {}),
    verification: {
      command: command.display, kind: 'test', scope: command.scope, status: 'blocked', exitCode: -1,
      countsReliable: false, timestamp: startedAt, durationMs: Date.now() - startedAt,
      userGuidance: content,
      ...(reason === 'timeout' ? { failureKind: 'timeout', blockedReason: 'timeout' } : {}),
    },
  }
}
