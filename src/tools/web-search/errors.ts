import type { FailureClass } from '../../agent/failure-classifier.js'

export type SearchFailureKind = Extract<FailureClass, 'timeout' | 'api_error' | 'permission_denied' | 'unknown'>

/** Preserve the actual response status instead of parsing a rendered report. */
export class SearchHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'SearchHttpError'
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

/** Unknown/permanent failures prevent replay of the whole backend chain. */
export function combineSearchFailures(kinds: readonly SearchFailureKind[]): SearchFailureKind {
  const permanent = kinds.find(kind => kind !== 'timeout' && kind !== 'api_error')
  if (permanent) return permanent
  // Do not promote an API failure into timeout: the retry allowlist still applies.
  if (kinds.includes('api_error')) return 'api_error'
  return kinds.length > 0 ? 'timeout' : 'unknown'
}

export function classifySearchError(error: unknown, timedOut: boolean): SearchFailureKind {
  if (timedOut) return 'timeout'
  const seen = new Set<unknown>()
  function visit(value: unknown): SearchFailureKind {
    if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 8) return 'unknown'
    seen.add(value)
    if (value instanceof SearchHttpError) {
      if (value.status === 401 || value.status === 403) return 'permission_denied'
      if (value.status === 408 || value.status === 504) return 'timeout'
      if ([429, 500, 502, 503].includes(value.status)) return 'api_error'
      return 'unknown'
    }
    if (value instanceof AggregateError) return combineSearchFailures(value.errors.map(visit))
    const { code, cause } = value as { code?: unknown; cause?: unknown }
    if (typeof code === 'string') return TRANSIENT_NETWORK_CODES.has(code) ? 'timeout' : 'unknown'
    return visit(cause)
  }
  return visit(error)
}
