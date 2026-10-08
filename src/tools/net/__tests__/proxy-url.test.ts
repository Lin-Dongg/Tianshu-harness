import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHttpProxyUrl } from '../proxy-url.js'
import { resolveProxyForUrl } from '../proxy-resolver.js'

test('proxy settings accept HTTP/HTTPS and legacy bare host ports, including IPv6', () => {
  for (const [raw, normalized] of [
    [' 127.0.0.1:7890 ', 'http://127.0.0.1:7890'],
    ['localhost:7890', 'http://localhost:7890'],
    ['[::1]:7890', 'http://[::1]:7890'],
    ['https://proxy.example.com:8443/', 'https://proxy.example.com:8443'],
    ['http://user:password@proxy.example.com:7890', 'http://user:password@proxy.example.com:7890'],
  ]) assert.equal(normalizeHttpProxyUrl(raw!), normalized)
  assert.equal(resolveProxyForUrl('https://example.com', { proxyUrl: '127.0.0.1:7890', noProxy: '' }), 'http://127.0.0.1:7890')
})

test('invalid proxies fail safely without exposing their contents or bypassing them', () => {
  for (const raw of ['wrong', 'http://', 'socks5://localhost:1080', 'ftp://localhost', 'http://localhost:0', 'http://localhost:99999', 'http://localhost/path', 'http://localhost?password=private-fixture']) {
    assert.throws(() => normalizeHttpProxyUrl(raw), { message: 'invalid_proxy_url' })
    assert.throws(() => resolveProxyForUrl('https://example.com', { proxyUrl: raw, noProxy: '' }), { message: 'invalid_proxy_url' })
  }
  assert.equal(resolveProxyForUrl('https://example.com', { proxyUrl: 'http://', noProxy: '*' }), undefined)
})
