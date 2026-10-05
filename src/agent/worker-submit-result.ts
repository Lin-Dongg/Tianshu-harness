/**
 * worker 的 submit_result 工具与收尾请求。
 *
 * submit_result 从 worker 首轮起就在工具表里；收尾请求直接延续探索循环最后一次发出的
 * 主轮请求：system、tools 与历史逐字节不变，只在末尾追加之后的会话消息和收尾指令，
 * tool_choice 保持 auto。约束缺一不可——DeepSeek 按 system → tools → 历史渲染前缀，
 * 工具表一变其后历史全部失配；思考模式又直接 400 拒绝强制 tool_choice（旧收尾阶段 1
 * 因此从未成功，阶段 2 整段未命中）。见 docs/known-issues/2026-10-04-worker-finalize-cache-miss.md。
 */

import { zodToJsonSchema } from 'zod-to-json-schema'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../api/stream-client.js'
import type { ContentBlock, ContentBlockToolUse, ToolDefinition, Usage } from '../api/types.js'
import type { PromptEngine } from '../prompt/engine.js'
import { applyDescriptionMode, type ToolDescriptionMode } from '../tools/description-compact.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { WORKER_RESULT_SUBMIT_SCHEMA, parseWorkerResult } from './work-order.js'

export const SUBMIT_RESULT_TOOL_NAME = 'submit_result'

/** 参数与 WORKER_RESULT_SUBMIT_SCHEMA（work-order.ts，workerResultIngestSchema 同源）严格
 *  一致——模型看到的参数形状与解析侧 ingest 权威校验共用一份定义。zod-to-json-schema 是
 *  MCP SDK 的传递依赖（package-lock 已锁定，未直接声明）。 */
const SUBMIT_RESULT_DEFINITION: ToolDefinition = {
  name: SUBMIT_RESULT_TOOL_NAME,
  description: '提交本工单的最终 WorkerResult 报告：参数即完整报告，与参数 JSON Schema 对齐。只在工作全部完成后调用一次——调用即交付，worker 随即结束。',
  input_schema: zodToJsonSchema(WORKER_RESULT_SUBMIT_SCHEMA, { target: 'openApi3' }) as ToolDefinition['input_schema'],
}

/** 序列化工具参数并过 ingest 权威校验（缺 workOrderId / 非法 status 等抛错）。 */
function serializeSubmittedReport(input: unknown, orderId: string): string {
  const serialized = JSON.stringify(input)
  parseWorkerResult(serialized, orderId)
  return serialized
}

/** 校验通过即交给 onAccepted 并结束本轮（endTurn）；不通过把错误回给模型，让它修正后重交。 */
export function createSubmitResultTool(orderId: string, onAccepted: (report: string) => void, onRejected?: (reason: string, raw: string) => void): Tool {
  return {
    definition: SUBMIT_RESULT_DEFINITION,
    async execute({ input }) {
      let report: string
      try {
        report = serializeSubmittedReport(input, orderId)
      } catch (err) {
        onRejected?.(String(err), JSON.stringify(input))
        return { content: `报告未通过校验：${err instanceof Error ? err.message : String(err)}\n修正后重新调用 submit_result。`, isError: true }
      }
      onAccepted(report)
      return { content: '报告已提交。', endTurn: true }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

/**
 * 返回挂上 submit_result 的派生 registry，并把定义插进引擎工具表——必须在 worker 首个
 * 请求之前调用。只插不改：其余定义的字节与顺序原样保留，submit_result 落在按名字排序
 * 应在的位置（与 ToolRegistry.getDefinitions 同序）。续跑复用同一引擎时 updateTools
 * 字节幂等，不算工具变更。
 */
export function mountSubmitResultTool(opts: {
  registry: ToolRegistry
  engine: PromptEngine
  toolDescriptions?: ToolDescriptionMode
  orderId: string
  onAccepted: (report: string) => void
  onRejected?: (reason: string, raw: string) => void
}): ToolRegistry {
  const tool = createSubmitResultTool(opts.orderId, opts.onAccepted, opts.onRejected)
  const registry = new ToolRegistry()
  for (const existing of opts.registry.getAll()) registry.register(existing)
  registry.register(tool)
  const [definition] = applyDescriptionMode([tool.definition], opts.toolDescriptions)
  const others = opts.engine.getTools().filter(d => d.name !== SUBMIT_RESULT_TOOL_NAME)
  const at = others.findIndex(d => d.name.localeCompare(SUBMIT_RESULT_TOOL_NAME) > 0)
  opts.engine.updateTools(at === -1
    ? [...others, definition!]
    : [...others.slice(0, at), definition!, ...others.slice(at)])
  return registry
}

export interface FinalizeStreamHooks {
  /** 收尾请求不走 AgentLoop，stall clock 只能吃这里上行的增量与心跳。 */
  onActivity?: (kind: 'text' | 'thinking' | 'lifecycle', detail?: string) => void
  /** 用量记账，含被中止的重试尝试（它们同样计费）。 */
  recordUsage?: (usage: Partial<Usage>) => void
  onReportRejected?: (reason: string, raw: string) => void
  keepaliveMs: number
  signal?: AbortSignal
}

/**
 * 收尾/修复类直发请求的公共流式外壳：增量上行、静默心跳、用量记账。返回流错误（无则
 * undefined）。报告写进工具参数时只有参数增量、没有可上行的文本，所以心跳按「距上次
 * 上行」判静默——按「距上次增量」判，参数流越长 stall clock 越饿。
 */
export async function streamFinalizeRequest(
  client: StreamClient,
  request: OaiChatRequest,
  sink: { onText?: (delta: string) => void; onBlock?: (block: ContentBlock) => void; onStop?: (reason: string) => void },
  hooks: FinalizeStreamHooks,
): Promise<Error | undefined> {
  let error: Error | undefined
  let lastEmitAt = Date.now()
  const emit = (kind: 'text' | 'thinking' | 'lifecycle', detail?: string): void => {
    lastEmitAt = Date.now()
    hooks.onActivity?.(kind, detail)
  }
  const keepalive = setInterval(() => {
    const silentMs = Date.now() - lastEmitAt
    if (silentMs >= hooks.keepaliveMs) emit('lifecycle', `finalizing report still running (${Math.round(silentMs / 1000)}s)`)
  }, hooks.keepaliveMs)
  keepalive.unref?.()
  try {
    await client.stream(request, {
      onTextDelta: (delta) => { sink.onText?.(delta); emit('text', delta) },
      onThinkingDelta: (delta) => { emit('thinking', delta) },
      onContentBlock: (block) => { sink.onBlock?.(block) },
      onStopReason: (reason, usage) => {
        sink.onStop?.(reason)
        if (usage) hooks.recordUsage?.(usage)
      },
      onStreamAttemptAborted: (info) => { if (info.usage) hooks.recordUsage?.(info.usage) },
      onError: (e) => { error = e },
    }, hooks.signal).catch((e: unknown) => { error = e as Error })
  } finally {
    clearInterval(keepalive)
  }
  return error
}

/** 探索循环最后一次发出的主轮请求，及发出时会话里已有的消息条数。 */
export interface MainRequestSnapshot {
  request: OaiChatRequest
  sessionLength: number
}

/** 主轮请求发出时回调（prefixProbe 只在主路径构建上为真，侧路请求都剥掉了它）。用 Proxy
 *  转发其余成员——手工包装对象会把 StreamClient 的可选成员静默丢成 undefined。 */
export function observeMainRequests(client: StreamClient, onMain: (request: OaiChatRequest) => void): StreamClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'stream') {
        return (request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal) => {
          if (request.prefixProbe) onMain(request)
          return target.stream(request, callbacks, signal)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * 收尾请求 = 最后一次主轮请求原样 + 其后新增的会话消息 + 收尾指令（剥掉主路径探针与
 * 该轮的预算快照）。
 * 不经引擎重建：那时活跃的 user 消息带着 <context-update> 附录，侧路构建不提交冻结
 * 快照、会把它重渲染成不带附录的样子，前缀从第一条 user 消息起失配。没有可延续的主轮
 * 请求、或会话在其后被改短时，拒绝全文收尾，交由有界报告修复/降级。
 */
export function buildClosingRequest(opts: {
  lastMain?: MainRequestSnapshot
  sessionMessages: readonly OaiMessage[]
  instruction: string
  engine: PromptEngine
  contextWindow: number
  maxTokens: number
}): OaiChatRequest | undefined {
  const instruction: OaiMessage = { role: 'user', content: opts.instruction }
  const last = opts.lastMain
  if (!last || opts.sessionMessages.length < last.sessionLength) {
    return undefined
  }
  return {
    ...last.request,
    messages: [...last.request.messages, ...opts.sessionMessages.slice(last.sessionLength), instruction],
    max_tokens: opts.maxTokens,
    prefixProbe: undefined,
    contextBudget: undefined,
  }
}

/**
 * 发出收尾请求，只收「恰好一个 submit_result 调用、参数未截断、过 ingest 校验」的报告；
 * 模型没调、多调、调了别的工具（收尾请求里不执行），或参数不合格 → null，调用方回退。
 */
export async function requestSubmittedReport(
  client: StreamClient,
  request: OaiChatRequest,
  orderId: string,
  hooks: FinalizeStreamHooks,
): Promise<string | null> {
  const toolUses: ContentBlockToolUse[] = []
  let text = ''
  let stop = ''
  const error = await streamFinalizeRequest(
    client,
    request,
    { onText: delta => { text += delta }, onStop: reason => { stop = reason }, onBlock: (block) => { if (block.type === 'tool_use') toolUses.push(block) } },
    hooks,
  )
  const reject = (reason: string): null => {
    hooks.onReportRejected?.(reason, text || JSON.stringify(toolUses))
    return null
  }
  if (error) return reject(error.message)
  if (stop === 'max_tokens' || stop === 'length') return reject('truncated')
  if (/[｜|]DSML[｜|]|<\/?(?:tool_calls|invoke|parameter)\b/i.test(text)) return reject('channel: DSML in report text')
  if (toolUses.length === 0 && text.trim()) {
    try { parseWorkerResult(text, orderId); return text } catch (err) { return reject(String(err)) }
  }
  if (toolUses.length !== 1) return reject('expected exactly one submit_result')
  const call = toolUses[0]!
  if (call.name !== SUBMIT_RESULT_TOOL_NAME) return reject(`channel: unexpected tool ${call.name}`)
  if (call.argsTruncated) return reject('truncated submit_result arguments')
  try {
    return serializeSubmittedReport(call.input, orderId)
  } catch (err) {
    return reject(String(err))
  }
}
