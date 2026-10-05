import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ToolDefinition } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool } from '../../tools/types.js'
import {
  SUBMIT_RESULT_TOOL_NAME, buildClosingRequest, createSubmitResultTool, mountSubmitResultTool, observeMainRequests,
} from '../worker-submit-result.js'

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: 'ok' }),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function registryOf(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of names) registry.register(fakeTool(name))
  return registry
}

function engineWith(tools: ToolDefinition[]): PromptEngine {
  return new PromptEngine({ model: 'deepseek-v4-flash', maxTokens: 1024, staticCtx: { tools }, volatileCtx: { cwd: '/repo' } })
}

const report = (workOrderId: string) => ({
  workOrderId,
  status: 'passed',
  summary: 'done',
  findings: [],
  artifacts: [],
  changedFiles: [],
  risks: [],
  nextActions: [],
})

describe('mountSubmitResultTool', () => {
  it('只插不改：其余定义字节与顺序不变，submit_result 落在名字序位置', () => {
    const source = registryOf('bash', 'read_file', 'write_file')
    const engine = engineWith(source.getDefinitions())
    const before = engine.getTools().map(d => JSON.stringify(d))

    const registry = mountSubmitResultTool({ registry: source, engine, orderId: 'wo_mount', onAccepted: () => {} })

    const after = engine.getTools()
    assert.deepEqual(after.map(d => d.name), ['bash', 'read_file', SUBMIT_RESULT_TOOL_NAME, 'write_file'])
    assert.deepEqual(after.filter(d => d.name !== SUBMIT_RESULT_TOOL_NAME).map(d => JSON.stringify(d)), before)
    assert.deepEqual(registry.getDefinitions().map(d => d.name), after.map(d => d.name), '与 registry 同序')
    assert.ok(!source.has(SUBMIT_RESULT_TOOL_NAME), '不改调用方传入的 registry')
  })

  it('续跑复用同一引擎时重挂字节幂等', () => {
    const source = registryOf('read_file')
    const engine = engineWith(source.getDefinitions())
    mountSubmitResultTool({ registry: source, engine, orderId: 'wo_again', onAccepted: () => {} })
    const first = JSON.stringify(engine.getTools())

    mountSubmitResultTool({ registry: source, engine, orderId: 'wo_again', onAccepted: () => {} })

    assert.equal(JSON.stringify(engine.getTools()), first)
  })
})

describe('createSubmitResultTool', () => {
  it('合规报告：交给 onAccepted 并结束本轮', async () => {
    const accepted: string[] = []
    const tool = createSubmitResultTool('wo_tool', r => accepted.push(r))
    const result = await tool.execute({ input: report('wo_tool'), toolUseId: 'tu_1', cwd: '/repo' })

    assert.equal(result.endTurn, true)
    assert.notEqual(result.isError, true)
    assert.deepEqual(JSON.parse(accepted[0]!), report('wo_tool'))
  })

  it('不合格报告：错误回给模型、不结束本轮、不交付', async () => {
    const accepted: string[] = []
    const tool = createSubmitResultTool('wo_tool', r => accepted.push(r))
    const result = await tool.execute({ input: { summary: 'done', status: 'passed' }, toolUseId: 'tu_1', cwd: '/repo' })

    assert.equal(result.isError, true)
    assert.notEqual(result.endTurn, true)
    assert.equal(accepted.length, 0)
    assert.match(result.content, /报告未通过校验/)
  })

  it('不需要审批——headless worker 会把要审批的调用直接拒掉', () => {
    const tool = createSubmitResultTool('wo_tool', () => {})
    assert.equal(tool.requiresApproval({ input: {}, toolUseId: 'tu_1', cwd: '/repo' }), false)
  })
})

describe('buildClosingRequest', () => {
  const tools = registryOf('read_file').getDefinitions()
  const lastMainRequest: OaiChatRequest = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'frozen system' },
      { role: 'user', content: 'task\n<context-update>contract</context-update>' },
    ],
    max_tokens: 1024,
    stream: true,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'read_file tool', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto',
    prefixProbe: true,
    contextBudget: { requestId: 'main-1', revision: 1 } as unknown as OaiChatRequest['contextBudget'],
  }
  const sessionMessages: OaiMessage[] = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'exploration done' },
  ]

  it('延续最后一次主轮请求：已发出的消息原样、其后的会话消息和收尾指令追加在末尾', () => {
    const closing = buildClosingRequest({
      lastMain: { request: lastMainRequest, sessionLength: 1 },
      sessionMessages,
      instruction: 'finalize',
      engine: engineWith(tools),
      contextWindow: 1_000_000,
      maxTokens: 4096,
    })
    assert.ok(closing)

    assert.deepEqual(closing.messages, [...lastMainRequest.messages, sessionMessages[1], { role: 'user', content: 'finalize' }])
    assert.equal(closing.tools, lastMainRequest.tools)
    assert.equal(closing.tool_choice, 'auto')
    assert.equal(closing.max_tokens, 4096)
    assert.equal(closing.prefixProbe, undefined, '侧路请求带探针会让下一主轮报幻影 wireDiverged')
    assert.equal(closing.contextBudget, undefined, '预算快照属于那一轮主请求')
    assert.equal(lastMainRequest.messages.length, 2, '不改已发出的请求')
  })

  it('没有可延续的主轮请求、或会话改短：不重建全文收尾', () => {
    const engine = engineWith(tools)
    for (const lastMain of [undefined, { request: lastMainRequest, sessionLength: 3 }]) {
      const closing = buildClosingRequest({
        lastMain, sessionMessages, instruction: 'finalize', engine, contextWindow: 1_000_000, maxTokens: 4096,
      })
      assert.equal(closing, undefined)
    }
  })
})

describe('observeMainRequests', () => {
  it('只记主轮请求（prefixProbe 为真），stream 照常转发', async () => {
    const sent: OaiChatRequest[] = []
    const client: StreamClient = { stream: async (request) => { sent.push(request) } }
    const observed: OaiChatRequest[] = []
    const wrapped = observeMainRequests(client, r => observed.push(r))
    const main: OaiChatRequest = { model: 'm', messages: [], stream: true, prefixProbe: true }
    const side: OaiChatRequest = { model: 'm', messages: [], stream: true }
    const noop = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }

    await wrapped.stream(main, noop)
    await wrapped.stream(side, noop)

    assert.deepEqual(sent, [main, side])
    assert.deepEqual(observed, [main])
  })

  it('可选成员原样转发、this 指向原 client（手工包装会把它们静默丢成 undefined）', () => {
    class Client implements StreamClient {
      private effort = 'high'
      async stream(): Promise<void> {}
      setReasoningEffort(effort: string): void { this.effort = effort }
      previewContextRequest(request: OaiChatRequest): OaiChatRequest { return { ...request, model: this.effort } }
    }
    const client = new Client()
    const wrapped = observeMainRequests(client, () => {})

    wrapped.setReasoningEffort!('low')
    assert.equal(wrapped.previewContextRequest!({ model: 'm', messages: [], stream: true }).model, 'low')
    assert.equal(wrapped.consumeWireDivergence, undefined, '原 client 没有的成员仍是 undefined')
    assert.ok(wrapped instanceof Client)
  })
})
