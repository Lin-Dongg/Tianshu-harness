/** A phone needs the HTTPS proxy origin, never the desktop's loopback address. */
export function remoteAccessOrigin(raw: string): string {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['/', '/mobile', '/mobile/'].includes(url.pathname)
      || ['localhost', '[::1]', '[::]', '0.0.0.0'].includes(url.hostname)
      || url.hostname.endsWith('.localhost') || url.hostname.startsWith('127.')
      || /^\[::ffff:7f[0-9a-f]{2}:/.test(url.hostname) || url.port === '0') throw new Error()
    return url.origin
  } catch { throw new Error('invalid_remote_https_address') }
}

export function createRemoteAccessEndpoint() {
  let baseUrl = ''
  return {
    get: () => baseUrl,
    hosts: () => baseUrl ? [new URL(baseUrl).hostname] : [],
    set: (raw: string) => { baseUrl = raw.trim() ? remoteAccessOrigin(raw) : ''; return baseUrl },
  }
}
