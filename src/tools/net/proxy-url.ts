export class InvalidProxyUrlError extends Error {
  readonly code = 'INVALID_PROXY_URL'
  constructor() { super('invalid_proxy_url') }
}

/** Reject bad explicit settings rather than silently changing the network route. */
export function normalizeHttpProxyUrl(value: string): string {
  let raw = value.trim()
  if (/^(?:[^\s/:@]+|\[[\da-f:]+\]):\d+$/i.test(raw)) raw = `http://${raw}`
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash
      || (url.pathname && url.pathname !== '/') || url.port === '0') throw new InvalidProxyUrlError()
    return url.href.replace(/\/$/, '')
  } catch { throw new InvalidProxyUrlError() }
}
