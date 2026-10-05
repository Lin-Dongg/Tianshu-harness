import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deepseekOfficialPricing, findUsagePricing } from '../deepseek-pricing.js'
import { deepseekPricingPhase, nextPricingTransition } from '../pricing-phase.js'
import { computeUsageCost } from '../pricing.js'
import { aggregateUsageRows, parseUsageRows } from '../../cache/usage-aggregator.js'
import { PROVIDER_PRESETS } from '../../config/provider-presets.js'

const peak = Date.parse('2026-09-28T01:00:00Z')
const idle = Date.parse('2026-09-28T04:00:00Z')
const holiday = Date.parse('2026-10-01T01:00:00Z')
const providers = { official: PROVIDER_PRESETS.deepseek.provider,
  gateway: { ...PROVIDER_PRESETS.deepseek.provider, baseUrl: 'https://gateway.example', models: [{ ...PROVIDER_PRESETS.deepseek.provider.models[0]!, id: 'deepseek-v4-flash', pricing: { input: 123, output: 456 } }] } }

test('official Flash aliases and Pro use current CNY peak and half-price idle rates', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.deepEqual(deepseekOfficialPricing(model, peak), { input: 2, output: 8, cacheRead: .04, cacheWrite: 2 })
    assert.deepEqual(deepseekOfficialPricing(model, idle), { input: 1, output: 4, cacheRead: .02, cacheWrite: 1 })
  }
  assert.deepEqual(deepseekOfficialPricing('deepseek-v4-pro', peak), { input: 9, output: 27, cacheRead: .30, cacheWrite: 9 })
  assert.deepEqual(deepseekOfficialPricing('deepseek-v4-pro', idle), { input: 4.5, output: 13.5, cacheRead: .15, cacheWrite: 4.5 })
})

test('holiday weekdays and weekend make-up workdays are off-peak; transition skips Spring Festival', () => {
  assert.equal(deepseekPricingPhase(holiday), 'offpeak')
  assert.equal(deepseekPricingPhase(Date.parse('2026-02-23T01:00:00Z')), 'offpeak')
  assert.equal(deepseekPricingPhase(Date.parse('2026-10-10T01:00:00Z')), 'offpeak')
  const before = Date.parse('2026-02-13T10:00:00Z')
  assert.equal(nextPricingTransition(before).inMs, Date.parse('2026-02-24T01:00:00Z') - before)
})

test('stale official preset overrides only official host; gateway keeps configured prices', () => {
  assert.equal(findUsagePricing(providers, 'official', 'deepseek-v4-flash', peak)?.output, 8)
  assert.equal(findUsagePricing(providers, 'gateway', 'deepseek-v4-flash', peak)?.output, 456)
  assert.equal(findUsagePricing(providers, 'missing', 'deepseek-v4-flash', peak), undefined)
})

test('cache aggregation forwards each request time: phase changes and holiday savings', () => {
  const row = (t: number) => JSON.stringify({ t, model: 'deepseek-v4-flash', provider: 'official', input: 1e6, cacheRead: .8e6, cacheCreate: .2e6, output: .5e6 })
  const aggregate = aggregateUsageRows(parseUsageRows([row(peak), row(idle), row(holiday)].join('\n')), {
    now: holiday, days: 10, resolvePricing: (model, provider, timestamp) => findUsagePricing(providers, provider, model, timestamp ?? holiday),
  })
  // peak=.032+.4+4=4.432; idle/holiday each=2.216
  assert.equal(aggregate.totals.cost, 8.864)
  assert.equal(aggregate.totals.savings, 3.136)
})

test('reasoning tokens included in output are not charged twice; explicit separate price still supported', () => {
  assert.equal(computeUsageCost({ input_tokens: 1e6, output_tokens: 1e6, reasoning_tokens: .8e6 }, deepseekOfficialPricing('deepseek-flash', peak)).total, 10)
  assert.equal(computeUsageCost({ output_tokens: 1e6, reasoning_tokens: .5e6 }, { output: 8, reasoning: 2 }).total, 9)
})
