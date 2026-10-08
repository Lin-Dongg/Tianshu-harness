import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { resolveProxyForUrl, type ProxyResolverOptions } from '../tools/net/proxy-resolver.js'
import type { FetchLike } from '../auth/account.js'

const agents = new Map<string, ProxyAgent>()

/** Resolve persisted network settings when sending, so retry follows new settings. */
export function createAccountFetch(network: () => ProxyResolverOptions): FetchLike {
  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const proxy = resolveProxyForUrl(url, network())
    if (!proxy) return fetch(input, init)
    let dispatcher = agents.get(proxy)
    if (!dispatcher) {
      dispatcher = new ProxyAgent({ uri: proxy })
      agents.set(proxy, dispatcher)
    }
    return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
  }) as FetchLike
}
