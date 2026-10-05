/**
 * provider 层重试可见性（dsh 式，2026-10-05）—— onRetryNotice 节流契约。
 *
 * 背景：客户端内 withStructuredRetry 的 429/503 退避预算长达 10-20 分钟
 * （maxTotalDurationMs），此前零事件——用户看到的是「卡住」。onRetryNotice
 * 只对 rate_limit / overloaded 两类发，且第 1 次与之后每 3 次发一次（防轰炸）。
 *
 * 契约（RED→GREEN）：
 * - 429 连打 5 次后成功 → 通知恰好落在第 1、4 次重试（attempt 1、4），
 *   带 category/maxAttempts/nextDelayMs；旧实现无 onRetryNotice → 0 条 → 红。
 * - 500（server_error，不在覆盖集）重试 → 零通知。
 * - 503（overloaded）→ 第 1 次重试有通知，category='overloaded'。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { StreamCallbacks } from '../stream-client.js'

const SSE_OK =
  'data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"index":0}]}\n\n'
  + 'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n'
  + 'data: [DONE]\n\n'

const FAST_RETRY: OpenAIClientConfig['retry'] = {
  backoff: { baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  overrides: {
    rate_limit: { retryDelayMs: 1 },
    overloaded: { retryDelayMs: 1 },
    server_error: { retryDelayMs: 1 },
  },
}

function makeConfig(): OpenAIClientConfig {
  return {
    baseUrl: 'https://api.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    maxTokens: 128,
    retry: FAST_RETRY,
  }
}

/** fetch 替身：前 `failures` 次回 `failStatus`，之后回一条正常 SSE。 */
function stubFlakyFetch(t: Parameters<typeof mock.method>[0], failures: number, failStatus: number) {
  let calls = 0
  return mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls <= failures) {
      return new Response(JSON.stringify({ error: { message: `upstream ${failStatus}` } }), {
        status: failStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
}

type Notice = { category: string; attempt: number; maxAttempts: number; nextDelayMs: number }

function makeCallbacks(notices: Notice[]): StreamCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
    onError: (e) => { throw e },
    onRetryNotice: (info) => { notices.push(info) },
  }
}

describe('onRetryNotice（provider 层重试可见性）', () => {
  it('429 连打 5 次：通知只在第 1、4 次重试发出（节流产率）', async (t) => {
    stubFlakyFetch(t, 5, 429)
    const client = new OpenAIClient(makeConfig())
    const notices: Notice[] = []

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      makeCallbacks(notices),
    )

    assert.deepEqual(notices.map((n) => n.attempt), [1, 4],
      '第 1 次与之后每 3 次发一次：attempt 1、4 有，2、3、5 无')
    assert.ok(notices.every((n) => n.category === 'rate_limit'))
    assert.ok(notices.every((n) => n.maxAttempts === 5), 'rate_limit 分类器默认上限 5')
    assert.ok(notices.every((n) => n.nextDelayMs > 0))
  })

  it('500（server_error，不在覆盖集）：重试照跑但零通知', async (t) => {
    stubFlakyFetch(t, 2, 500)
    const client = new OpenAIClient(makeConfig())
    const notices: Notice[] = []

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      makeCallbacks(notices),
    )

    assert.equal(notices.length, 0, 'server_error 不属于 rate_limit/overloaded 覆盖集——不发通知')
  })

  it('503（overloaded）：第 1 次重试即通知，category=overloaded', async (t) => {
    stubFlakyFetch(t, 1, 503)
    const client = new OpenAIClient(makeConfig())
    const notices: Notice[] = []

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      makeCallbacks(notices),
    )

    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.category, 'overloaded')
    assert.equal(notices[0]!.attempt, 1)
  })

  it('调用方未接 onRetryNotice（默认关）：重试照常，无通知侧效应', async (t) => {
    stubFlakyFetch(t, 1, 429)
    const client = new OpenAIClient(makeConfig())
    const texts: string[] = []

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      {
        onTextDelta: (s) => texts.push(s),
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: (e) => { throw e },
      },
    )

    assert.ok(texts.join('').includes('ok'), '缺省关闭时重试链行为不变')
  })
})
