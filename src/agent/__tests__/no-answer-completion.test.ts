import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { AgentCallbacks } from '../loop-types.js'

async function runScenario(outputs: string[], maxTurns = 0, thinking = true, steer = '') {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-no-answer-'))
  const session = new SessionContext()
  const requests: OaiChatRequest[] = []
  const phases: Array<{ source?: string; reason?: string }> = []
  const finals: Array<string | undefined> = []
  let beforeFinal = ''
  const client = {
    stream: async (request: OaiChatRequest, cb: StreamCallbacks) => {
      requests.push(structuredClone(request))
      const text = outputs[requests.length - 1] ?? ''
      if (thinking) {
        cb.onThinkingDelta('Let me search for the domain definition.')
        cb.onContentBlock({ type: 'thinking', thinking: 'Let me search for the domain definition.' })
      }
      if (text) { cb.onTextDelta(text); cb.onContentBlock({ type: 'text', text }) }
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 })
    },
  } as StreamClient
  const engine = new PromptEngine({ model: 'deepseek-v4-flash', maxTokens: 1024, staticCtx: { tools: [] }, volatileCtx: { cwd } })
  const agent = new AgentLoop({ client, promptEngine: engine, toolRegistry: new ToolRegistry(), maxTurns, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, cwd)
  const callbacks: AgentCallbacks = {
    onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: () => {},
    onTurnComplete: (_u, _t, final, _e, _c, reason) => { if (final) finals.push(reason) },
    onPhaseChange: (phase, detail) => {
      if (phase === 'stop-reason') { phases.push(detail ?? {}); beforeFinal = JSON.stringify(session.getMessages()) }
    },
    onError: e => { throw e }, onAbort: () => {}, onApprovalRequired: async () => false,
    onSteerDrain: async () => { const pending = steer; steer = ''; return pending || null },
  }
  await agent.run('inspect the domain prompt', callbacks)
  return { requests, phases, finals, session, beforeFinal }
}

test('reasoning-only recovery exhausted: explicit no-answer terminal without rewriting cache history', async () => {
  const r = await runScenario(['', ''])
  assert.equal(r.requests.length, 2, 'one bounded recovery')
  assert.equal(r.phases.at(-1)?.source, 'no-answer')
  assert.match(r.phases.at(-1)?.reason ?? '', /未完成.*未返回有效答案/)
  assert.equal(r.finals.at(-1), 'no_answer')
  assert.equal(JSON.stringify(r.session.getMessages()), r.beforeFinal, 'terminal notice must not enter model history')
  const [first, retry] = r.requests
  assert.equal(JSON.stringify(first!.tools), JSON.stringify(retry!.tools), 'tool definitions stay byte stable')
  assert.equal(JSON.stringify(first!.messages), JSON.stringify(retry!.messages.slice(0, first!.messages.length)), 'recovery only appends after the existing prefix')
  assert.ok(!JSON.stringify(r.session.getMessages()).includes('未返回有效答案'))
})

test('recovery that returns an answer finishes normally', async () => {
  const r = await runScenario(['', 'Found the prompt definition.'])
  assert.equal(r.requests.length, 2)
  assert.equal(r.phases.at(-1)?.source, 'natural-finish')
  assert.equal(r.finals.at(-1), undefined)
})

test('empty output and whitespace output do not count as answers at the final turn', async () => {
  for (const output of ['', ' \n ']) {
    const r = await runScenario([output], 1)
    assert.equal(r.phases.at(-1)?.source, 'no-answer')
    assert.equal(r.finals.at(-1), 'no_answer')
  }
})

test('a completely empty response is incomplete without inventing model history', async () => {
  const r = await runScenario([''], 0, false)
  assert.equal(r.requests.length, 1)
  assert.equal(r.phases.at(-1)?.source, 'no-answer')
  assert.equal(r.finals.at(-1), 'no_answer')
  assert.equal(JSON.stringify(r.session.getMessages()), r.beforeFinal)
})

test('pending user guidance is consumed before declaring an empty response incomplete', async () => {
  const r = await runScenario(['', 'Found the requested definition.'], 0, false, 'check src/agent')
  assert.equal(r.requests.length, 2)
  assert.ok(JSON.stringify(r.requests[1]!.messages).includes('check src/agent'))
  assert.equal(r.phases.at(-1)?.source, 'natural-finish')
})
