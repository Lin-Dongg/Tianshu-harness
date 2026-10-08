import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { httpFetchGuarded, type FetchLike } from '../http-fetch.js'
import { isPrivateIP, isProxyFakeIPv4, SSRFError } from '../ssrf.js'
import { configSchema, networkSchema } from '../../../config/schema.js'
import { buildFetchOptions } from '../../web-fetch/build-options.js'
import { createWebFetchTool } from '../../web-fetch/tool.js'

let savedEnv: Record<string, string | undefined>
const envKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY', 'RIVET_FETCH_PIN']
beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  process.env.RIVET_NO_SYSTEM_PROXY = '1'
})
afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

async function withProxy(run: (proxyUrl: string) => Promise<void>, listener: RequestListener = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('via trusted proxy')
}): Promise<void> {
  const proxy = createServer(listener)
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`) }
  finally { await new Promise<void>((resolve, reject) => proxy.close(err => err ? reject(err) : resolve())) }
}

describe('httpFetchGuarded #400 narrow fake-IP exception', () => {
  it('keeps the reserved range blocked and defaults trust to false', () => {
    assert.equal(networkSchema.parse({}).trustProxyFakeIp, false)
    for (const ip of ['198.18.0.0', '198.19.255.255']) {
      assert.equal(isPrivateIP(ip), true)
      assert.equal(isProxyFakeIPv4(ip), true)
    }
    for (const ip of ['198.17.255.255', '198.20.0.0', '::ffff:198.18.0.1', 'invalid']) assert.equal(isProxyFakeIPv4(ip), false)
  })

  for (const pin of ['1', '0']) {
    it(`uses the real proxy for a trusted domain fake-IP (pin=${pin})`, async () => {
      process.env.RIVET_FETCH_PIN = pin
      await withProxy(async proxyUrl => {
        const result = await httpFetchGuarded('http://github.example/readme', {
          lookup: async () => ({ address: '198.18.0.66', family: 4 }),
        }, { proxy: { proxyUrl, noProxy: '' }, trustProxyFakeIp: true })
        assert.equal(new TextDecoder().decode(result.bytes), 'via trusted proxy')
      })
    })
  }

  for (const mode of ['disabled', 'direct', 'no-proxy', 'custom-fetch']) {
    it(`rejects fake-IP when ${mode}`, async () => {
      let fetched = false
      await assert.rejects(() => httpFetchGuarded('http://github.example/readme', {
        lookup: async () => ({ address: '198.18.0.66', family: 4 }),
        ...(mode === 'custom-fetch' ? { fetch: (async () => { fetched = true; return new Response('unexpected') }) as unknown as FetchLike } : {}),
      }, {
        proxy: mode === 'direct' ? undefined : { proxyUrl: 'http://127.0.0.1:9', noProxy: mode === 'no-proxy' ? 'github.example' : '' },
        trustProxyFakeIp: mode !== 'disabled',
      }), (err: unknown) => err instanceof SSRFError && /fake-IP/.test(err.message))
      assert.equal(fetched, false)
    })
  }

  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '203.0.113.1', '::1', '::ffff:198.18.0.1']) {
    it(`retains the guard for ${ip} despite proxy trust`, async () => {
      await assert.rejects(() => httpFetchGuarded('http://target.example/', {
        lookup: async () => ({ address: ip }),
      }, { proxy: { proxyUrl: 'http://127.0.0.1:9', noProxy: '' }, trustProxyFakeIp: true }), SSRFError)
    })
  }

  it('rejects a fake-IP literal even if an injected lookup returns a public address', async () => {
    await assert.rejects(() => httpFetchGuarded('http://198.18.0.66/', {
      lookup: async () => ({ address: '8.8.8.8', family: 4 }),
    }, { proxy: { proxyUrl: 'http://127.0.0.1:9', noProxy: '' }, trustProxyFakeIp: true }), SSRFError)
  })

  for (const redirect of ['private', 'no-proxy', 'literal']) {
    it(`rechecks the ${redirect} redirect before sending another proxy request`, async () => {
      let requests = 0
      await withProxy(async proxyUrl => {
        await assert.rejects(() => httpFetchGuarded('http://start.example/', {
          lookup: async host => ({ address: host === 'private.example' ? '10.0.0.1' : '198.18.0.66', family: 4 }),
        }, { proxy: { proxyUrl, noProxy: 'direct.example' }, trustProxyFakeIp: true }), SSRFError)
        assert.equal(requests, 1)
      }, (_req, res) => {
        requests++
        const location = redirect === 'literal' ? 'http://198.18.0.66/' : `http://${redirect === 'private' ? 'private' : 'direct'}.example/`
        res.writeHead(302, { location })
        res.end()
      })
    })
  }

  it('follows domain fake-IP redirects through the trusted proxy', async () => {
    let requests = 0
    await withProxy(async proxyUrl => {
      const result = await httpFetchGuarded('http://start.example/', {
        lookup: async () => ({ address: '198.19.255.255', family: 4 }),
      }, { proxy: { proxyUrl, noProxy: '' }, trustProxyFakeIp: true })
      assert.equal(result.finalUrl, 'http://final.example/')
      assert.equal(requests, 2)
    }, (_req, res) => {
      if (++requests === 1) res.writeHead(302, { location: 'http://final.example/' })
      else res.writeHead(200)
      res.end('final')
    })
  })

  it('does not retry directly when the proxy connection fails', async () => {
    let resolutions = 0
    await withProxy(async proxyUrl => {
      await assert.rejects(() => httpFetchGuarded('http://target.example/', {
        lookup: async () => { resolutions++; return { address: '198.18.0.66', family: 4 } },
      }, { proxy: { proxyUrl, noProxy: '' }, trustProxyFakeIp: true, timeoutMs: 1000 }))
    }, req => req.socket.destroy())
    assert.equal(resolutions, 1)
  })

  for (const jina of [false, true]) {
    it(`wires config through the real web_fetch ${jina ? 'Jina fallback' : 'main request'}`, async () => {
      const requested: string[] = []
      await withProxy(async proxyUrl => {
        const config = configSchema.parse({
          provider: { default: 'unused', providers: {} },
          network: { proxy: proxyUrl, noProxy: '', trustProxyFakeIp: true },
          fetch: { enablePlaywright: false, jinaBaseUrl: 'http://reader.example' },
        })
        const tool = createWebFetchTool({
          lookup: async () => ({ address: '198.18.0.66', family: 4 }),
          cache: { read: async () => undefined, write: async () => {} },
        }, { ...buildFetchOptions(config), enablePlaywright: false })
        const result = await tool.execute({ input: { url: 'http://target.example/page' }, toolUseId: 'fakeip', cwd: '/unused' })
        assert.ok(!result.isError, result.content)
        assert.match(result.content, /verified proxy content/)
        assert.equal(requested.length, jina ? 2 : 1)
        if (jina) assert.ok(requested[1]?.startsWith('http://reader.example/'))
      }, (req, res) => {
        requested.push(req.url ?? '')
        const shell = jina && requested.length === 1
        res.writeHead(200, { 'content-type': shell ? 'text/html' : 'text/plain' })
        res.end(shell ? '<p>Please enable JavaScript</p>' : `verified proxy content ${'x'.repeat(300)}`)
      })
    })
  }
})
