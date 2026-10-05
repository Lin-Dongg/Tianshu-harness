import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'

export interface CallAuditContext {
  requestId?: string
  attemptId?: string
  sessionId?: string
  parentRequestId?: string
  workOrderId?: string
  provider?: string
  model?: string
  purpose?: string
  routeReason?: string
  configFingerprint?: string
}
export interface CallAuditRecord extends CallAuditContext {
  operationId: string
  t: number
  phase: 'started' | 'finished'
  status?: 'complete' | 'failed' | 'aborted'
  responseId?: string
  responseModel?: string
  systemFingerprint?: string
  finishReason?: string
  usage?: Record<string, number>
  usageKnown?: boolean
  errorName?: string
}

function path(): string { return join(rivetHome(), 'logs', 'provider-calls.jsonl') }
function append(record: CallAuditRecord): void {
  try { mkdirSync(join(rivetHome(), 'logs'), { recursive: true }); appendFileSync(path(), `${JSON.stringify(record)}\n`, { mode: 0o600 }) } catch { /* audit cannot break execution */ }
}

/** Accepts only diagnostic fields, never request bodies or authentication headers. */
export function beginCallAudit(context: CallAuditContext) {
  const operationId = context.attemptId ?? randomUUID()
  const identity: CallAuditContext = Object.fromEntries(Object.entries(context).filter(([key, value]) =>
    ['requestId', 'attemptId', 'sessionId', 'parentRequestId', 'workOrderId', 'provider', 'model', 'purpose', 'routeReason', 'configFingerprint'].includes(key) && typeof value === 'string'))
  append({ ...identity, operationId, t: Date.now(), phase: 'started' })
  let finished = false
  return {
    operationId,
    finish(result: Pick<CallAuditRecord, 'status' | 'responseId' | 'responseModel' | 'systemFingerprint' | 'finishReason' | 'usage' | 'errorName'>) {
      if (finished) return
      finished = true
      const usage = result.usage && Object.fromEntries(Object.entries(result.usage).filter(([key, n]) => /^(?:input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|reasoning_tokens|prompt_tokens|completion_tokens|total_tokens|prompt_cache_hit_tokens|prompt_cache_miss_tokens)$/.test(key) && Number.isFinite(n) && n >= 0))
      append({ ...identity, operationId, t: Date.now(), phase: 'finished', status: result.status,
        responseId: result.responseId, responseModel: result.responseModel, systemFingerprint: result.systemFingerprint,
        finishReason: result.finishReason, errorName: result.errorName, usage, usageKnown: !!usage && Object.keys(usage).length > 0 })
    },
  }
}

export function auditConfigFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

export function readCallAudit(filters: { model?: string; sessionId?: string; purpose?: string; since?: number } = {}): CallAuditRecord[] {
  const records = new Map<string, CallAuditRecord>()
  try {
    for (const line of readFileSync(path(), 'utf8').split('\n')) {
      try { const row = JSON.parse(line) as CallAuditRecord; if (row.operationId) records.set(row.operationId, row) } catch { /* interrupted tail */ }
    }
  } catch { return [] }
  return [...records.values()].filter(row => (!filters.model || row.model === filters.model || row.responseModel === filters.model)
    && (!filters.sessionId || row.sessionId === filters.sessionId) && (!filters.purpose || row.purpose === filters.purpose)
    && (!filters.since || row.t >= filters.since)).sort((a, b) => b.t - a.t).slice(0, 500)
}

export function requestAuditContext(config: { sessionId?: string; providerName?: string }, request: { diagnostics?: { purpose?: string; parentRequestId?: string; workOrderId?: string; routeReason?: string } }): CallAuditContext {
  return { requestId: randomUUID(), sessionId: config.sessionId, provider: config.providerName,
    purpose: request.diagnostics?.purpose ?? (config.sessionId?.startsWith('worker-') ? 'worker_execution' : 'main_execution'),
    parentRequestId: request.diagnostics?.parentRequestId, workOrderId: request.diagnostics?.workOrderId, routeReason: request.diagnostics?.routeReason }
}

export function observedAuditUsage(usage: Partial<import('./types.js').Usage> | undefined): Record<string, number> | undefined {
  if (!usage) return undefined
  const fields = usage.observation?.fields
  return Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'reasoning_tokens']
    .filter(key => (!fields || key in fields) && typeof usage[key as keyof typeof usage] === 'number')
    .map(key => [key, usage[key as keyof typeof usage] as number]))
}
