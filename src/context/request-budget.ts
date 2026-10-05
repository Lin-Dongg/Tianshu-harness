import { estimateOaiMessageTokens } from '../compact/micro.js'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { ContextBudgetSnapshot } from '../server/protocol.js'

export const DEEPSEEK_WINDOW = 1_048_576
/**
 * 官方 DeepSeek 支持的**单次输出上限**（能力天花板），用于 `buildContextBudget` 的越界
 * 判定：`outputReserve > maxOutputTokens → blocked`。
 *
 * 它与 preset 的 `maxTokens` 分工不同，**不要合并成一个数**：
 *   - 本常量 = 上限（官方标称 384K）。存量 `config.json` 存的是 preset **快照**，
 *     `deepMerge` 整体替换数组（见 config/preset-model-backfill.ts 头注释），所以
 *     preset 的改动到不了存量会话——它们仍带 384_000。上限一旦收到 256K，这些会话
 *     会被全部判成 blocked（实测：`ContextBudgetExceededError`，输出预留 384000），
 *     是线上全挂而非纸面风险。
 *   - preset `maxTokens` = 每次请求的**默认**输出（现取 256K，对齐官方 harness 的
 *     `DEFAULT_MAX_TOKENS`）。真正决定 `outputReserve` 与 inputBudget 大小的是它。
 * 仅当请求未携带 `max_tokens` 时，本常量才作为 `outputReserve` 的兜底。
 */
export const DEEPSEEK_MAX_OUTPUT = 393_216
/**
 * 现实单次输出预留 —— 与能力上限 `DEEPSEEK_MAX_OUTPUT`(384K) 是两回事。拿 384K（能力天花板）
 * 当 `outputReserve` 会把可输入压到窗口的 ~57%（1M 窗口只剩 566K），等于用「最坏情况」堵死常态。
 *
 * 取值 256K = provider preset 的 `maxTokens`（与官方 harness 的 DEFAULT_MAX_TOKENS 同语义）。
 * **不取更小值**：preset 注释在案「2026-07-01 误改为 6.4 万导致 reasoning_effort=max 时推理未完
 * 即被 length 截断、loop 收到空响应判死停止——硬下限教训」，且失效方向是**调高**。故本值只用于
 * **封顶吸收旧快照漂移**（久 config 的 384K → 256K），不额外削减预设的输出能力。
 *
 * 它同时是 wire `max_tokens` 的封顶，保证 `input + max_tokens ≤ window` 这条硬约束不被破坏
 *（两者必须同源，否则大输入时上游 400）。
 */
export const DEEPSEEK_OUTPUT_RESERVE = 256_000
export const DEEPSEEK_BODY_LIMIT = 48 * 1024 * 1024

/** Only verified official models opt in. Unknown endpoints keep their contract. */
export function isOfficialDeepSeek(baseUrl: string, model: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com'
      && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].includes(model)
  } catch { return false }
}

export interface RequestBudgetPolicy {
  windowTokens: number
  maxOutputTokens: number
}

export function deepSeekBudgetPolicy(baseUrl: string, model: string, configuredWindow?: number): RequestBudgetPolicy | undefined {
  if (!isOfficialDeepSeek(baseUrl, model)) return undefined
  return {
    windowTokens: Math.min(configuredWindow && configuredWindow > 0 ? configuredWindow : DEEPSEEK_WINDOW, DEEPSEEK_WINDOW),
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT,
  }
}

export function inputBudgetFor(windowTokens: number, outputReserve: number): { inputBudget: number; safetyMargin: number } {
  const safetyMargin = Math.max(16_384, Math.ceil(windowTokens * 0.05))
  return { inputBudget: Math.max(0, windowTokens - outputReserve - safetyMargin), safetyMargin }
}

export function estimateBudgetInput(messages: OaiMessage[], tools?: unknown): Pick<ContextBudgetSnapshot, 'inputTokens' | 'imageTokens' | 'reasoningTokens' | 'toolTokens'> {
  let inputTokens = 0, imageTokens = 0, reasoningTokens = 0
  for (const message of messages) {
    // The native vision contract has an upper bound of 1024 tokens per image.
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') inputTokens += estimateOaiMessageTokens({ role: 'user', content: part.text })
        else { inputTokens += 1024; imageTokens += 1024 }
      }
    } else {
      inputTokens += estimateOaiMessageTokens(message)
    }
    if (message.role === 'assistant' && message.reasoning_content) {
      reasoningTokens += estimateOaiMessageTokens({ role: 'user', content: message.reasoning_content })
    }
    inputTokens += 8 // role / delimiters / message framing
  }
  const toolTokens = tools ? estimateOaiMessageTokens({ role: 'user', content: JSON.stringify(tools) }) : 0
  return { inputTokens: inputTokens + toolTokens, imageTokens, reasoningTokens, toolTokens }
}

export function buildContextBudget(request: Pick<OaiChatRequest, 'messages' | 'tools' | 'model' | 'max_tokens'>, policy: RequestBudgetPolicy, identity: { requestId: string; revision: number }): ContextBudgetSnapshot {
  // outputReserve 封顶到「现实输出预留」而非能力上限——见 DEEPSEEK_OUTPUT_RESERVE 注释。
  const outputReserve = Math.min(request.max_tokens ?? policy.maxOutputTokens, DEEPSEEK_OUTPUT_RESERVE)
  const budget = inputBudgetFor(policy.windowTokens, outputReserve)
  const counts = estimateBudgetInput(request.messages, request.tools)
  const ratio = budget.inputBudget > 0 ? counts.inputTokens / budget.inputBudget : Infinity
  return {
    ...identity, sampledAt: Date.now(), model: request.model,
    windowTokens: policy.windowTokens, ...budget, ...counts, outputReserve,
    source: 'estimate',
    state: outputReserve > policy.maxOutputTokens || ratio > 1 ? 'blocked' : ratio >= 0.85 ? 'warning' : 'ready',
  }
}

export class ContextBudgetExceededError extends Error {
  constructor(readonly budget: ContextBudgetSnapshot) {
    super(`上下文需要整理：预计输入 ${budget.inputTokens}，可用输入 ${budget.inputBudget}，输出预留 ${budget.outputReserve}。本次请求尚未发送；请压缩上下文或减少当前附件。`)
    this.name = 'ContextBudgetExceededError'
  }
}

export function assertContextBudget(budget: ContextBudgetSnapshot): void {
  if (budget.state === 'blocked') throw new ContextBudgetExceededError(budget)
}
