import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
export interface UpdateRestartManager {
  updateRestartActivity(): { sessions: number; tasks: number }
  prepareUpdateRestart(force: boolean, signal: AbortSignal): Promise<void>
  cancelUpdateRestart(): void
}
export function buildUpdateRestartRoutes(manager: UpdateRestartManager, apiToken?: string): Record<string, RouteHandler> {
  let preparing = false
  let cancellation: AbortController | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { cancellation?.abort(); cancellation = undefined; clearTimeout(expiry); manager.cancelUpdateRestart(); preparing = false }
  return {
    'GET /runtime/update-activity': withAuth(() => ({ status: 200, body: manager.updateRestartActivity() }), apiToken),
    'POST /runtime/update-prepare': withAuth(async body => {
      if (preparing) return { status: 409, body: { error: 'UPDATE_PREPARING' } }
      preparing = true
      const controller = new AbortController(); cancellation = controller
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      try {
        await manager.prepareUpdateRestart((body as { force?: unknown } | undefined)?.force === true, deadline)
        // An abandoned client must not leave the runtime permanently frozen.
        expiry = setTimeout(cancel, 120000); expiry.unref()
        return { status: 200, body: { prepared: true } }
      } catch (error) {
        cancel()
        return { status: error instanceof Error && error.message === 'UPDATE_BUSY' ? 409 : 503, body: { error: error instanceof Error && error.message === 'UPDATE_BUSY' ? 'UPDATE_BUSY' : 'UPDATE_SAVE_FAILED', ...manager.updateRestartActivity() } }
      }
    }, apiToken),
    'POST /runtime/update-cancel': withAuth(() => { cancel(); return { status: 200, body: { cancelled: true } } }, apiToken),
  }
}
