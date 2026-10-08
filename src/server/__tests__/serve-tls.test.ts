import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { startServer } from '../index.js'
import { assertSecureBind, readServeTlsArgs } from '../serve-transport.js'

test('TLS options require both certificate and identity files', () => {
  assert.equal(readServeTlsArgs([]), undefined)
  assert.throws(() => readServeTlsArgs(['--tls-cert', 'missing']), /supplied together/)
  assert.throws(() => readServeTlsArgs(['--tls-key', '--port']), /Missing value/)
})

test('real TLS LAN listener keeps Bearer auth and serves encrypted responses', async (t) => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) }
  catch { t.skip('openssl is required to generate an ephemeral test certificate'); return }
  const dir = mkdtempSync(join(tmpdir(), 'serve-tls-'))
  const cert = join(dir, 'certificate.pem'), identity = join(dir, 'identity.pem')
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', identity, '-out', cert], { stdio: 'ignore' })
    server = await startServer(0, { 'GET /ping': () => ({ status: 200, body: { ok: true } }) }, 'fixture', {
      host: '0.0.0.0', tls: readServeTlsArgs(['--tls-cert', cert, '--tls-key', identity]),
    })
    const get = (authorization?: string, host?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server!.port, path: '/ping', rejectUnauthorized: false,
        headers: { ...(authorization ? { authorization } : {}), ...(host ? { host } : {}) } }, res => {
        let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode!, body }))
      }); req.on('error', reject); req.end()
    })
    assert.equal((await get()).status, 401)
    assert.equal((await get('Bearer fixture', 'evil.example')).status, 403)
    const result = await get('Bearer fixture')
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body), { ok: true })
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-loopback binds require TLS before starting a listener', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '127.evil.example']) assert.throws(() => assertSecureBind(host), /requires TLS/)
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.doesNotThrow(() => assertSecureBind(host))
  assert.doesNotThrow(() => assertSecureBind('0.0.0.0', { cert: 'fixture', key: 'fixture' }))
})
