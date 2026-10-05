/**
 * 审批风险解释（Wave 1-2）。
 *
 * 两条设计约束是本文件的断言重点：
 *  1. 严格走侧路——请求不得携带 prefixProbe（会毒化主路径的 wire 基线，
 *     2026-07-06 事故），且不得原地改写调用方的消息数组。
 *  2. 失败一律静默降级为 null——风险解释拿不到不该影响审批本身。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { explainToolRisk, parseRiskExplanation } from '../risk-explain.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test' },
  })
}

function history(): OaiMessage[] {
  return [
    { role: 'user', content: '帮我把构建产物清干净' },
    { role: 'assistant', content: '好的，我先看一下 dist 目录' },
  ]
}

function replyingClient(text: string, captured?: { request?: OaiChatRequest }): StreamClient {
  return {
    stream: async (request: OaiChatRequest, cb: StreamCallbacks) => {
      if (captured) captured.request = request
      cb.onTextDelta(text)
    },
  }
}

function deps(client: StreamClient | undefined, messages: OaiMessage[] = history()) {
  return {
    client,
    promptEngine: makeEngine(),
    getMessages: () => messages,
    contextWindow: 128_000,
  }
}

describe('parseRiskExplanation', () => {
  it('取首行评级，其余为正文', () => {
    const r = parseRiskExplanation('RISK: high\n删除整个目录，不可逆。\n影响 dist/ 下全部产物。')
    assert.equal(r?.level, 'high')
    assert.deepEqual(r?.lines, ['删除整个目录，不可逆。', '影响 dist/ 下全部产物。'])
  })

  it('容忍反引号包裹与大小写', () => {
    assert.equal(parseRiskExplanation('`RISK: LOW`\n只读操作。')?.level, 'low')
  })

  it('缺评级时保守判 medium 而非放行', () => {
    const r = parseRiskExplanation('这条命令会重写配置文件。')
    assert.equal(r?.level, 'medium', '解析不出评级时不该乐观判 low')
    assert.deepEqual(r?.lines, ['这条命令会重写配置文件。'])
  })

  it('只有评级没有正文 → 视为无结果', () => {
    assert.equal(parseRiskExplanation('RISK: low'), null)
  })

  it('空输入 → null', () => {
    assert.equal(parseRiskExplanation('   \n  '), null)
  })

  it('正文行数超限时截断，避免把待批命令挤出屏幕', () => {
    const long = 'RISK: low\n' + Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    assert.ok((parseRiskExplanation(long)?.lines.length ?? 0) <= 6)
  })
})

describe('explainToolRisk — 侧路纪律', () => {
  it('请求不得携带 prefixProbe（否则毒化主路径 wire 基线）', async () => {
    const captured: { request?: OaiChatRequest } = {}
    await explainToolRisk(
      deps(replyingClient('RISK: high\n不可逆删除。', captured)),
      { toolName: 'bash', input: { command: 'rm -rf dist' } },
    )
    assert.equal(captured.request?.prefixProbe, undefined, '侧路请求必须剥掉 prefixProbe')
  })

  it('不给工具定义，也不允许调用工具', async () => {
    const captured: { request?: OaiChatRequest } = {}
    await explainToolRisk(
      deps(replyingClient('RISK: low\n只读。', captured)),
      { toolName: 'bash', input: { command: 'ls' } },
    )
    assert.equal(captured.request?.tools, undefined)
    // 新骨架以「不提供 tools」表达无工具——tool_choice 随之缺席。
    assert.equal(captured.request?.tool_choice, undefined)
  })

  it('不原地改写调用方的消息数组（同一 request 会被多个 stream 重入）', async () => {
    const messages = history()
    const snapshot = messages.map(m => ({ ...m }))
    await explainToolRisk(
      deps(replyingClient('RISK: low\n只读。'), messages),
      { toolName: 'bash', input: { command: 'ls' } },
    )
    assert.deepEqual(messages, snapshot, '调用方历史必须逐字节不变')
  })

  it('请求前缀沿用完整对话历史——复用主前缀才有缓存命中', async () => {
    const captured: { request?: OaiChatRequest } = {}
    await explainToolRisk(
      deps(replyingClient('RISK: low\n只读。', captured), history()),
      { toolName: 'bash', input: { command: 'ls' } },
    )
    const sent = captured.request?.messages ?? []
    assert.ok(
      sent.some(m => String(m.content).includes('帮我把构建产物清干净')),
      '必须带上原始历史，而不是只发一条孤立指令',
    )
    assert.match(String(sent[sent.length - 1]?.content), /RISK: low/, '指令追加在末尾')
  })
})

describe('explainToolRisk — 失败静默降级', () => {
  it('无客户端 → null，且不抛', async () => {
    const r = await explainToolRisk(deps(undefined), { toolName: 'bash', input: {} })
    assert.equal(r, null)
  })

  it('流报错 → null', async () => {
    const client: StreamClient = {
      stream: async (_r: OaiChatRequest, cb: StreamCallbacks) => { cb.onError(new Error('boom')) },
    }
    assert.equal(await explainToolRisk(deps(client), { toolName: 'bash', input: {} }), null)
  })

  it('stream 抛异常 → null，不外溢到审批流程', async () => {
    const client: StreamClient = { stream: async () => { throw new Error('network down') } }
    assert.equal(await explainToolRisk(deps(client), { toolName: 'bash', input: {} }), null)
  })

  it('模型无输出 → null', async () => {
    const client: StreamClient = { stream: async () => { /* 无 delta */ } }
    assert.equal(await explainToolRisk(deps(client), { toolName: 'bash', input: {} }), null)
  })
})

describe('explainToolRisk — 成本记账', () => {
  it('有 usage 时记入侧路账本（侧路也是要付钱的）', async () => {
    const booked: Array<{ input: number; model: string }> = []
    const client: StreamClient = {
      stream: async (request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('RISK: low\n只读。')
        cb.onStopReason('stop', { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1100 })
        void request
      },
    }
    await explainToolRisk(
      { ...deps(client), recordUsage: (u, model) => { booked.push({ input: u.input_tokens ?? 0, model }) } },
      { toolName: 'bash', input: { command: 'ls' } },
    )
    assert.equal(booked.length, 1)
    assert.equal(booked[0]?.input, 1200)
  })
})
