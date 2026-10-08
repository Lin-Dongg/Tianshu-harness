import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { startServer } from '../index.js'
import { buildRemoteInfoRoutes } from '../remote-info-routes.js'
import { createRemoteAccessEndpoint, remoteAccessOrigin } from '../remote-access-endpoint.js'

test('only HTTPS phone origins can be registered; malformed input never replaces the existing host', () => {
  const endpoint = createRemoteAccessEndpoint()
  assert.equal(endpoint.set('https://computer.tailnet.ts.net/mobile/'), 'https://computer.tailnet.ts.net')
  for (const url of ['http://192.168.1.1', 'https://localhost', 'https://app.localhost', 'https://127.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://0.0.0.0', 'https://user:password@example.com', 'https://example.com/#token=fixture', 'https://example.com/foo', 'wrong']) {
    assert.throws(() => endpoint.set(url), { message: 'invalid_remote_https_address' })
    assert.deepEqual(endpoint.hosts(), ['computer.tailnet.ts.net'])
  }
  assert.equal(remoteAccessOrigin('https://[2001:db8::8]:8443'), 'https://[2001:db8::8]:8443')
  endpoint.set(''); assert.deepEqual(endpoint.hosts(), [])
})

test('production shares endpoint registration with the actual listener Host check', () => {
  const source = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8')
  assert.match(source, /const remoteEndpoint = createRemoteAccessEndpoint\(\)/)
  assert.match(source, /buildRemoteInfoRoutes\([^\n]*endpoint: remoteEndpoint/)
  assert.match(source, /startServer\([^\n]*additionalAllowedHosts: remoteEndpoint.hosts/)
})

test('real loopback listener accepts the exact configured proxy Host and preserves mobile and API auth', async () => {
  const endpoint = createRemoteAccessEndpoint()
  const dir = mkdtempSync(join(tmpdir(), 'remote-phone-'))
  writeFileSync(join(dir, 'mobile.html'), '<!doctype html><title>Phone fixture</title>')
  const server = await startServer(0, buildRemoteInfoRoutes('fixture-access', { host: '127.0.0.1', endpoint }), 'fixture-access', {
    host: '127.0.0.1', mobileDir: dir, additionalAllowedHosts: endpoint.hosts,
  })
  const send = (path: string, host?: string, token?: string, baseUrl?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path, method: baseUrl === undefined ? 'GET' : 'PUT',
      headers: { host: host ?? `127.0.0.1:${server.port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode!, body }))
    }); req.on('error', reject); req.end(baseUrl === undefined ? undefined : JSON.stringify({ baseUrl }))
  })
  try {
    assert.equal((await send('/mobile/', 'computer.tailnet.ts.net')).status, 403)
    assert.equal((await send('/remote/endpoint', undefined, undefined, 'https://computer.tailnet.ts.net')).status, 401)
    assert.equal((await send('/remote/endpoint', undefined, 'fixture-access', 'https://computer.tailnet.ts.net')).status, 200)
    assert.equal((await send('/mobile/', 'computer.tailnet.ts.net')).status, 200)
    assert.equal((await send('/remote/info', 'computer.tailnet.ts.net')).status, 401)
    const remote = await send('/remote/info', 'computer.tailnet.ts.net', 'fixture-access')
    assert.equal(remote.status, 200)
    assert.equal(JSON.parse(remote.body).remoteBaseUrl, 'https://computer.tailnet.ts.net')
    assert.deepEqual(JSON.parse(remote.body).allowedHosts, ['computer.tailnet.ts.net'])
    assert.equal((await send('/remote/info', 'evil.example', 'fixture-access')).status, 403)
    assert.equal((await send('/remote/endpoint', undefined, 'fixture-access', 'http://bad.example')).status, 400)
    assert.equal((await send('/mobile/', 'computer.tailnet.ts.net')).status, 200)
    await send('/remote/endpoint', undefined, 'fixture-access', 'https://replacement.tailnet.ts.net')
    assert.equal((await send('/mobile/', 'computer.tailnet.ts.net')).status, 403)
    assert.equal((await send('/mobile/', 'replacement.tailnet.ts.net')).status, 200)
    await send('/remote/endpoint', undefined, 'fixture-access', '')
    assert.equal((await send('/mobile/', 'replacement.tailnet.ts.net')).status, 403)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
