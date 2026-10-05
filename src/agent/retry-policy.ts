import { isTransient, type FailureClass } from './failure-classifier.js'

export interface RetryPolicyInput {
  toolName: string
  failureClass: FailureClass
  isConcurrencySafe: boolean
  retryableClasses: string[]
  retriesRemaining: number
}

export interface RetryPolicyDecision {
  retry: boolean
  reason: string
}

const NON_IDEMPOTENT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'undo',
  'rollback',
  // commit=true 有 git 提交副作用（issue #356）：门禁拒绝重试必然复现，
  // 且重试会重新进入 commit。工具级保守：连同 commit=false 只读查询一并禁自动重试。
  'deliver_task',
])

function isMcpWriteTool(toolName: string): boolean {
  const match = toolName.match(/^mcp__(.+)__(.+)$/)
  if (!match) return false
  const mcpToolName = match[2]!
  return /(?:^|[_-])(?:write|create|update|delete|remove|push|post|put|patch|execute)(?:$|[_-])/i.test(mcpToolName)
}

export function shouldRetryToolFailure(input: RetryPolicyInput): RetryPolicyDecision {
  if (input.retriesRemaining <= 0) {
    return { retry: false, reason: 'No retries remaining.' }
  }

  if (!isTransient(input.failureClass) || !input.retryableClasses.includes(input.failureClass)) {
    return { retry: false, reason: `Failure class ${input.failureClass} is not retryable.` }
  }

  if (NON_IDEMPOTENT_TOOLS.has(input.toolName) || isMcpWriteTool(input.toolName)) {
    return { retry: false, reason: `Tool ${input.toolName} is non-idempotent and must not be auto-retried.` }
  }

  if (!input.isConcurrencySafe) {
    return { retry: false, reason: `Tool ${input.toolName} is not concurrency-safe.` }
  }

  return { retry: true, reason: 'Transient failure on concurrency-safe tool.' }
}
