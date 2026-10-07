import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import type { ProviderUsageSnapshot } from './protocol.js'

interface ProviderUsageModule {
  getProviderUsage(force?: boolean): Promise<ProviderUsageSnapshot>
}

let implementation: Promise<ProviderUsageModule | null> | undefined
async function loadImplementation(): Promise<ProviderUsageModule | null> {
  implementation ??= (async () => {
    for (const url of [
      new URL('../pro/provider-usage/index.js', import.meta.url),
      new URL('./pro/provider-usage/index.js', import.meta.url),
    ]) {
      try {
        const module = await import(url.href) as ProviderUsageModule
        if (typeof module.getProviderUsage === 'function') return module
      } catch { /* Optional desktop implementation is absent in public builds. */ }
    }
    return null
  })()
  return implementation
}

/** Closed-source adapters are available to all desktop tiers; no license gate. */
export function buildProviderUsageRoutes(
  apiToken?: string,
  load: () => Promise<ProviderUsageModule | null> = loadImplementation,
): Record<string, RouteHandler> {
  const handler = (force: boolean): RouteHandler => async (body, _params, headers) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    const module = await load()
    const snapshot: ProviderUsageSnapshot = module
      ? await module.getProviderUsage(force)
      : { available: false, defaultAccount: null, accounts: [] }
    return { status: 200, body: snapshot }
  }
  return {
    'GET /config/provider-usage': handler(false),
    'POST /config/provider-usage/refresh': handler(true),
  }
}
