export type BrowserErrorCode = 'control_conflict' | 'stale_context' | 'invalid_input' | 'capability_unsupported' | 'browser_disconnected' | 'operation_failed' | 'no_selection' | 'resource_limit'
const statuses: Record<BrowserErrorCode, number> = {
  resource_limit: 429, control_conflict: 409, stale_context: 409, invalid_input: 400,
  capability_unsupported: 501, browser_disconnected: 503, operation_failed: 500, no_selection: 422,
}
export class BrowserOperationError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) { super(message) }
}
export function browserErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof BrowserOperationError ? error.code :
    /target (?:page, context or browser has been |closed)|browser (?:has been closed|disconnected)|session closed|connection closed/i.test(message) ? 'browser_disconnected' : 'operation_failed'
  return { status: statuses[code], body: { code, error: error instanceof Error ? error.message : String(error) } }
}
