import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRouter } from '../index.js'
import { buildProviderUsageRoutes } from '../provider-usage-routes.js'
import { buildConfigRoutes } from '../config-routes.js'

test('usage endpoints are mounted in the actual config router', async () => {
  const router = createRouter(buildConfigRoutes('fixture-auth'))
  assert.equal((await router('GET', '/config/provider-usage', {}, {})).status, 401)
  assert.equal((await router('POST', '/config/provider-usage/refresh', {}, {})).status, 401)
})

test('both usage endpoints are fail-closed before loading any credentials', async () => {
  let loaded = 0
  const router = createRouter(buildProviderUsageRoutes('fixture-auth', async () => { loaded++; return null }))
  for (const method of ['GET', 'POST']) {
    const path = method === 'GET' ? '/config/provider-usage' : '/config/provider-usage/refresh'
    assert.equal((await router(method, path, {}, {})).status, 401)
    assert.equal((await router(method, path, {}, { authorization: 'Bearer wrong' })).status, 401)
  }
  assert.equal(loaded, 0)
})

test('public builds degrade gracefully and desktop needs no Pro license', async () => {
  const router = createRouter(buildProviderUsageRoutes('fixture-auth', async () => null))
  const result = await router('GET', '/config/provider-usage', {}, { authorization: 'Bearer fixture-auth' })
  assert.deepEqual(result, { status: 200, body: { available: false, defaultAccount: null, accounts: [] } })
})

test('GET reads cache, POST refreshes, arbitrary request input is not passed to adapters', async () => {
  const calls: boolean[] = []
  const snapshot = { available: true, defaultAccount: null, accounts: [] }
  const router = createRouter(buildProviderUsageRoutes('fixture-auth', async () => ({ getProviderUsage: async force => { calls.push(!!force); return snapshot } })))
  const headers = { authorization: 'Bearer fixture-auth' }
  assert.deepEqual((await router('GET', '/config/provider-usage', {}, headers)).body, snapshot)
  assert.deepEqual((await router('POST', '/config/provider-usage/refresh', { apiKey: 'should-not-use', baseUrl: 'https://evil.test' }, headers)).body, snapshot)
  assert.deepEqual(calls, [false, true])
})
