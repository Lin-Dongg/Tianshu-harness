import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebSearchTool } from '../tool.js'
import { BraveBackend } from '../brave.js'
import { TavilyBackend } from '../tavily.js'
import { BochaBackend } from '../bocha.js'
import { SerplyBackend } from '../serply.js'
import { BingBackend } from '../bing.js'
import { DuckDuckGoBackend } from '../duckduckgo.js'
import { runBackendChain } from '../chain.js'
import { OFF_TOPIC_ERROR } from '../relevance.js'
import { classifyToolFailure } from '../../../agent/failure-classifier.js'
import type { SearchBackend, SearchFetch } from '../types.js'

const params = { cwd: '/tmp', toolUseId: 'search-regression', input: { query: 'q' } }
const failing = (name: string, error: unknown): SearchBackend => ({
  name, isAvailable: () => true, search: async () => { throw error },
})
const factories = [
  (fetch: SearchFetch) => new BraveBackend(fetch, 'fixture'),
  (fetch: SearchFetch) => new TavilyBackend(fetch, 'fixture'),
  (fetch: SearchFetch) => new BochaBackend(fetch, 'fixture'),
  (fetch: SearchFetch) => new SerplyBackend(fetch, 'fixture'),
  (fetch: SearchFetch) => new BingBackend(fetch),
  (fetch: SearchFetch) => new DuckDuckGoBackend(fetch),
]

it('invalid query has a structural format_error and never calls a backend', async () => {
  let calls = 0
  const tool = createWebSearchTool({ backends: [{
    name: 'timeout-backend', isAvailable: () => true, search: async () => { calls++; return [] },
  }] })
  for (const query of [undefined, '', '   ', {}]) {
    const out = await tool.execute({ ...params, input: { query } })
    assert.equal(out.isError, true)
    assert.equal(out.errorKind, 'format_error')
  }
  assert.equal(calls, 0)
})

it('backend names and raw messages cannot invent a timeout or HTTP failure', async () => {
  for (const message of ['timeout 300 is not a supported query', 'HTTP 503 was mentioned in the query', 'fetch failed']) {
    const out = await createWebSearchTool({ backends: [failing('timeout-backend', new Error(message))] }).execute(params)
    assert.equal(out.isError, true)
    assert.equal(out.errorKind, 'unknown')
    assert.ok(out.content.includes(message), 'retain the raw diagnostic')
    assert.equal(classifyToolFailure(out, out.content).retryable, false)
  }
})

for (const factory of factories) {
  const name = factory(async () => new Response('')).name
  it(`${name}: actual HTTP status reaches the tool without text classification`, async () => {
    for (const [status, expected] of [[401, 'permission_denied'], [403, 'permission_denied'], [400, 'unknown'], [408, 'timeout'], [429, 'api_error'], [500, 'api_error'], [503, 'api_error'], [504, 'timeout']] as const) {
      const out = await createWebSearchTool({ backends: [factory(async () => new Response('', { status }))] }).execute(params)
      assert.equal(out.isError, true)
      assert.equal(out.errorKind, expected, `${name}: HTTP ${status}`)
      assert.match(out.content, new RegExp(`HTTP ${status}`))
    }
  })
}

it('actual backend timeout has structural timeout classification', async () => {
  const backend: SearchBackend = {
    name: 'provider', isAvailable: () => true,
    search: async (_query, _count, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  }
  const out = await createWebSearchTool({ backends: [backend], timeoutMs: 5 }).execute(params)
  assert.equal(out.errorKind, 'timeout')
  assert.match(out.content, /timed out/)
})

it('an unrelated AbortError is not described or classified as a backend timeout', async () => {
  const out = await createWebSearchTool({ backends: [failing('provider', new DOMException('cancelled', 'AbortError'))] }).execute(params)
  assert.equal(out.errorKind, 'unknown')
  assert.match(out.content, /cancelled/)
  assert.doesNotMatch(out.content, /timed out/)
})

it('real network codes survive direct, cause and aggregate errors', async () => {
  const network = Object.assign(new Error('transport failed'), { code: 'ECONNRESET' })
  for (const error of [network, new TypeError('fetch failed', { cause: network }), new AggregateError([network], 'connection failed')]) {
    const out = await createWebSearchTool({ backends: [failing('provider', error)] }).execute(params)
    assert.equal(out.errorKind, 'timeout')
  }
})

it('a permanent backend failure prevents retrying the entire mixed chain', async () => {
  for (const permanentFirst of [true, false]) {
    const permanent = new BraveBackend(async () => new Response('', { status: 403 }), 'fixture')
    const transient = failing('provider', Object.assign(new Error('transport failed'), { code: 'ETIMEDOUT' }))
    const backends = permanentFirst ? [permanent, transient] : [transient, permanent]
    const out = await createWebSearchTool({ backends }).execute(params)
    assert.equal(out.errorKind, 'permission_denied')
    assert.equal(classifyToolFailure(out, out.content).retryable, false)
  }
})

it('an unknown error within an aggregate network error remains non-retryable', async () => {
  const error = new AggregateError([
    Object.assign(new Error('transport failed'), { code: 'ECONNRESET' }), new Error('unsupported request timeout'),
  ], 'fetch failed')
  const out = await createWebSearchTool({ backends: [failing('provider', error)] }).execute(params)
  assert.equal(out.errorKind, 'unknown')
})

it('thrown failures cannot masquerade as soft outcomes by reusing their messages', async () => {
  for (const message of ['no results', OFF_TOPIC_ERROR]) {
    const out = await createWebSearchTool({ backends: [failing('provider', new Error(message))] }).execute(params)
    assert.equal(out.isError, true)
    assert.equal(out.errorKind, 'unknown')
  }
})

it('unknown and cyclic causes do not create retryable network failures', async () => {
  const cyclic = new Error('fetch failed')
  cyclic.cause = cyclic
  for (const error of [cyclic, new AggregateError([], 'fetch failed'), Object.assign(new Error('timeout'), { code: 'EACCES' })]) {
    const out = await createWebSearchTool({ backends: [failing('provider', error)] }).execute(params)
    assert.equal(out.errorKind, 'unknown')
    assert.equal(classifyToolFailure(out, out.content).retryable, false)
  }
})

it('the chain retains structured failure metadata without changing raw diagnostics', async () => {
  const out = await runBackendChain([failing('provider', Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }))], 'q', 5, 1000)
  assert.equal(out.errors[0]?.errorKind, 'timeout')
  assert.equal(out.errors[0]?.message, 'connection lost')
})

it('empty and successful fallback results do not acquire an errorKind', async () => {
  for (const results of [[], [{ title: 'q', snippet: 'q', url: 'https://example.invalid' }]]) {
    const out = await createWebSearchTool({ backends: [failing('timeout-provider', new Error('failed')), {
      name: 'fallback', isAvailable: () => true, search: async () => results,
    }] }).execute(params)
    if (results.length > 0) {
      assert.equal(out.isError, undefined)
      assert.equal(out.errorKind, undefined)
    } else {
      assert.equal(out.errorKind, 'unknown', 'an empty fallback does not erase a hard failure')
    }
  }
  const empty = await createWebSearchTool({ backends: [{ name: 'empty', isAvailable: () => true, search: async () => [] }] }).execute(params)
  assert.equal(empty.isError, undefined)
  assert.equal(empty.errorKind, undefined)
})
