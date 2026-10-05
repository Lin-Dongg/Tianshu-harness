/**
 * `/btw` 侧问引擎（Wave 1-3）。
 *
 * 侧问的价值全押在两件事上：**看得见完整对话**（否则答不了"刚才那个报错"）与
 * **没有工具**（否则它就是个普通 subagent，还白改了前缀）。本文件逐条把这两点
 * 以及共享的侧路纪律钉死。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { askSideQuestion, buildSideQuestionInstruction } from '../side-question.js'
import { askSidePath } from '../side-path-ask.js'
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
    { role: 'user', content: '跑测试的时候报了 TS2322' },
    { role: 'assistant', content: '我看一下 src/foo.ts 的类型定义' },
  ]
}

function deps(client: StreamClient | undefined, messages: OaiMessage[] = history()) {
  return { client, promptEngine: makeEngine(), getMessages: () => messages, contextWindow: 128_000 }
}

function replying(text: string, captured?: { request?: OaiChatRequest }): StreamClient {
  return {
    stream: async (request: OaiChatRequest, cb: StreamCallbacks) => {
      if (captured) captured.request = request
      for (const ch of text) cb.onTextDelta(ch)
    },
  }
}

describe('buildSideQuestionInstruction', () => {
  it('明确声明无工具，堵住"我去读个文件"这条路', () => {
    const s = buildSideQuestionInstruction('这是什么错？')
    assert.match(s, /没有任何工具/)
    assert.match(s, /不要猜/)
  })

  it('明确声明回答不进历史', () => {
    assert.match(buildSideQuestionInstruction('q'), /不会进入对话历史/)
  })

  it('原样带上问题', () => {
    assert.match(buildSideQuestionInstruction('TS2322 是什么意思？'), /TS2322 是什么意思？/)
  })
})

describe('askSideQuestion', () => {
  it('带上完整对话历史——这是它能答"刚才那个报错"的前提', async () => {
    const captured: { request?: OaiChatRequest } = {}
    await askSideQuestion(deps(replying('是类型不匹配。', captured)), { question: '刚才那个报错什么意思' })
    const sent = captured.request?.messages ?? []
    assert.ok(sent.some(m => String(m.content).includes('TS2322')), '历史必须在场')
  })

  it('不给工具定义，也不允许调用', async () => {
    const captured: { request?: OaiChatRequest } = {}
    await askSideQuestion(deps(replying('答案', captured)), { question: 'q' })
    assert.equal(captured.request?.tools, undefined)
    // 新骨架以「不提供 tools」表达无工具——协议上无 tools 则 tool_choice 缺席，
    // 不再发旧的 tool_choice:'none' 形态。
    assert.equal(captured.request?.tool_choice, undefined)
  })

  it('不携带 prefixProbe，主路径 wire 基线不被污染', async () => {
    const captured: { request?: OaiChatRequest } = {}
    await askSideQuestion(deps(replying('答案', captured)), { question: 'q' })
    assert.equal(captured.request?.prefixProbe, undefined)
  })

  it('不改动调用方的消息数组', async () => {
    const messages = history()
    const snapshot = messages.map(m => ({ ...m }))
    await askSideQuestion(deps(replying('答案'), messages), { question: 'q' })
    assert.deepEqual(messages, snapshot)
  })

  it('流式增量按序回调，最终文本与增量拼接一致', async () => {
    const seen: string[] = []
    const full = await askSideQuestion(deps(replying('类型不匹配')), {
      question: 'q',
      onDelta: c => { seen.push(c) },
    })
    assert.equal(seen.join(''), '类型不匹配')
    assert.equal(full, '类型不匹配')
  })

  it('空问题 → 不发请求', async () => {
    let called = false
    const client: StreamClient = { stream: async () => { called = true } }
    assert.equal(await askSideQuestion(deps(client), { question: '   ' }), null)
    assert.equal(called, false)
  })

  it('出错 → null，不外溢', async () => {
    const client: StreamClient = { stream: async () => { throw new Error('down') } }
    assert.equal(await askSideQuestion(deps(client), { question: 'q' }), null)
  })
})

describe('askSidePath — 共享骨架的记账', () => {
  it('侧路 usage 记入账本', async () => {
    const booked: number[] = []
    const client: StreamClient = {
      stream: async (_r: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('x')
        cb.onStopReason('stop', { input_tokens: 900, cache_read_input_tokens: 880, output_tokens: 12 })
      },
    }
    await askSidePath(
      { ...deps(client), recordUsage: u => { booked.push(u.input_tokens ?? 0) } },
      { instruction: 'q' },
    )
    assert.deepEqual(booked, [900])
  })

  it('usage 缺失时按未知观察上报（不伪造数字；归零/落盘由 recorder 决定）', async () => {
    // 设计第 6 节：「不再以 input>0 作为有用量条件；未知 input 保留字段状态
    // unknown，不能记为已知零」。丢弃守卫位于 side-path-usage-recorder
    // （全空且无 observation 才丢），通道层不再吞掉空观察。
    const booked: Array<Partial<import('../../api/types.js').Usage>> = []
    const client: StreamClient = {
      stream: async (_r: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('x')
        cb.onStopReason('stop', {})
      },
    }
    await askSidePath(
      { ...deps(client), recordUsage: u => { booked.push(u) } },
      { instruction: 'q' },
    )
    assert.equal(booked.length, 1, '空 usage 也带身份上报——未覆盖请求数才能在聚合侧可见')
    assert.equal(booked[0]!.input_tokens, undefined, '未知保持 unknown，不得记为已知零')
  })
})
