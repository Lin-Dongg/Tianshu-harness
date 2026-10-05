/**
 * max_tokens 截断提醒（dsh 式，2026-10-05）—— 检测与透传链。
 *
 * 契约（RED→GREEN）：
 * - 流式以 finish_reason 'length'（客户端已归一为 'max_tokens'）收尾的 turn，
 *   natural-finish 时 onTurnComplete 第 6 参（additive stopReason）必须是
 *   'max_tokens'——此前 stopReason 在 turn-orchestrator 解构后零消费，截断完全静默。
 * - 正常 end_turn 收尾不携带 stopReason（不污染 wire）。
 *
 * 旧实现：onTurnComplete 只有 5 个参数 → 第 6 参恒 undefined → 用例红。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-maxtokens-'))

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** 单轮文本流，stopReason 由参数决定（'max_tokens' = finish_reason 'length' 归一后）。 */
function makeClient(stopReason: string): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      cb.onTextDelta('被截断的回答')
      cb.onContentBlock({ type: 'text', text: '被截断的回答' })
      cb.onStopReason(stopReason, { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client, promptEngine: makeEngine(), toolRegistry: registry,
    maxTurns: 1, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

describe('max_tokens 截断：stopReason 随 turn_complete 透传', () => {
  it("finish_reason 'length'（max_tokens）收尾 → final onTurnComplete 带 stopReason 'max_tokens'", async () => {
    const agent = makeAgent(makeClient('max_tokens'))

    const completions: Array<{ isFinal?: boolean; stopReason?: string }> = []
    await agent.run('hi', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_u, _t, isFinal, _e, _c, stopReason) => { completions.push({ isFinal, stopReason }) },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const final = completions.filter((c) => c.isFinal).at(-1)
    assert.ok(final, '应有 final turn_complete')
    assert.equal(final.stopReason, 'max_tokens', '截断收尾必须携带 stopReason=max_tokens（此前零消费、完全静默）')
  })

  it('正常 end_turn 收尾 → 不携带 stopReason（wire 保持干净）', async () => {
    const agent = makeAgent(makeClient('end_turn'))

    const completions: Array<{ isFinal?: boolean; stopReason?: string }> = []
    await agent.run('hi', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_u, _t, isFinal, _e, _c, stopReason) => { completions.push({ isFinal, stopReason }) },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const final = completions.filter((c) => c.isFinal).at(-1)
    assert.ok(final, '应有 final turn_complete')
    assert.equal(final.stopReason, undefined, '正常收尾不得携带 stopReason')
  })
})
