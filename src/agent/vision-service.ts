/**
 * Vision bridge — describes images through a dedicated multimodal model.
 *
 * When the primary model does not support vision, user-supplied image data URLs
 * are routed here to produce a text description, which is then prepended to the
 * primary prompt so the main model still receives the image content.
 */

import { createHash } from 'node:crypto'
import type { Usage } from '../api/types.js'
import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest, OaiContentPart } from '../api/oai-types.js'

// 通用模式：结构化描述，便于 text-only 主控定位关键信息。分节让主控能快速跳到
// 「文字内容 / 界面元素 / 可能意图」，而不是读一段泛泛的散文。
const GENERAL_VISION_PROMPT =
  '请用中文分析这张图片，按以下结构输出：\n'
  + '## 文字内容\n（逐字转写图中所有可见文字，尤其是报错、代码、按钮、标签；无则写"无"）\n'
  + '## 界面元素\n（描述界面结构、控件、布局、状态）\n'
  + '## 可能意图\n（推测用户为何发这张图、想解决什么）'

// UI/报错精确模式：截图里往往关键就一行报错，泛泛描述会丢掉它。要求 OCR 级逐字转写。
const UI_PRECISE_VISION_PROMPT =
  '这是一张 UI/终端/代码截图。请用中文精确处理：\n'
  + '## 文字内容（逐字转写，一字不差）\n'
  + '（OCR 级转写所有可见文本：报错信息、堆栈、命令、代码、日志、路径、行号，'
  + '保留原始大小写和标点。这是最重要的部分，不要概括、不要省略、不要翻译）\n'
  + '## 界面结构\n（窗口/面板/终端布局，高亮或选中的区域，光标位置）\n'
  + '## 可能意图\n（用户想解决的问题）'

/** UI/报错截图判定关键词——命中则用精确转写模式而非泛泛描述。 */
const UI_INTENT_PATTERN =
  /报错|error|异常|exception|traceback|堆栈|stack|失败|failed|终端|terminal|命令行|console|日志|log|代码|code|截图|screenshot|报错信息|panic|警告|warning|崩溃|crash|报错行|栈/i

/**
 * 选择识图 prompt：
 * 1) 用户/配置显式给了 prompt → 永远优先，原样用。
 * 2) 否则据随图文本判定：命中 UI/报错关键词 → 精确转写模式；其余 → 通用结构化模式。
 */
export function selectVisionPrompt(configuredPrompt?: string, accompanyingText?: string): string {
  if (configuredPrompt && configuredPrompt.trim()) return configuredPrompt
  if (accompanyingText && UI_INTENT_PATTERN.test(accompanyingText)) return UI_PRECISE_VISION_PROMPT
  return GENERAL_VISION_PROMPT
}

/**
 * Cache the exact question or selected prompt digest. Callers bind this to
 * the actual vision model and image identity; case differences stay distinct.
 */
export function visionCacheKey(question?: string, configuredPrompt?: string, accompanyingText?: string): string {
  const q = question?.trim()
  if (q) return `q:${createHash('sha256').update(q).digest('hex')}`
  const prompt = selectVisionPrompt(configuredPrompt, accompanyingText)
  return `prompt:${createHash('sha256').update(prompt).digest('hex')}`
}

export interface DescribeImagesOptions {
  /** Prompt template for the vision model. 显式给定时优先于 accompanyingText 推断。 */
  prompt?: string
  /** 随图发送的用户文本，用于自动选择通用/精确转写模式（prompt 未显式给定时）。 */
  accompanyingText?: string
  /** Max output tokens for the description. */
  maxTokens?: number
  /** Abort signal. */
  signal?: AbortSignal
  model?: string
  purpose?: 'vision_description' | 'vision_question'
  recordUsage?: (usage: Partial<Usage>) => void
  onOutcome?: (outcome: { complete: boolean; reason: string }) => void
}

/**
 * Send one or more images to a multimodal model and return a text description.
 *
 * The client is assumed to be already configured with the correct provider and
 * model (e.g. built by create-agent-config's vision bridge). This function wraps
 * the streaming interface into a one-shot completion.
 */
export async function describeImages(
  client: StreamClient,
  images: string[],
  options: DescribeImagesOptions = {},
): Promise<string> {
  if (images.length === 0) return ''

  const prompt = selectVisionPrompt(options.prompt, options.accompanyingText)
  const parts: OaiContentPart[] = [{ type: 'text', text: prompt }]
  for (const url of images) {
    // 防御：校验 data URL 格式，不合法时提前报错
    if (!url.startsWith('data:')) {
      throw new Error(`图片 URL 不是 data URL 格式，请检查图片数据`)
    }
    const commaIdx = url.indexOf(',')
    const header = commaIdx >= 0 ? url.slice(0, commaIdx) : url
    // 白名单与 provider 实际能力对齐：输入层（image-attach / clipboard-image）
    // 已把 bmp/tiff 转 PNG，这里再拦一道，别把 provider 不识的格式送出去。
    if (!/^data:image\/(png|jpeg|gif|webp);base64$/.test(header)) {
      throw new Error(
        `图片格式不受视觉模型支持（期望 image/png, image/jpeg, image/gif, image/webp），`
        + `实际头部: ${header.slice(0, 60)}${header.length > 60 ? '…' : ''}`
      )
    }
    const payloadLen = commaIdx >= 0 ? url.length - commaIdx - 1 : 0
    if (payloadLen < 64) {
      throw new Error(`图片数据异常短（${payloadLen} 字符），可能被截断`)
    }
    parts.push({ type: 'image_url', image_url: { url } })
  }

  const request: OaiChatRequest = {
    model: options.model ?? '', // client binds the model when absent
    messages: [{ role: 'user', content: parts }],
    max_tokens: options.maxTokens ?? 1024,
    stream: true,
    diagnostics: { purpose: options.purpose ?? 'vision_description' },
  }

  // 两个回调携带的是**同一段文本**，不是两半：onTextDelta 是流式增量（给 UI），
  // onContentBlock 在收流结束时把累积的完整文本再发一次（给持久化——openai-client
  // 那处注释写明 agent loop 靠 content block 落库）。消费方必须取其一；原先两边都
  // 往一个数组里塞，于是每次桥接的描述都被精确复制一遍：注入主历史的 token 翻倍，
  // 模型读到的还是一段自我重复的文字。实测 MiniMax-M3 描述一张截图返回 3516 字，
  // 其中一半是复本。以 content block 为准（它是权威终值），没有它才退回增量拼接
  // （早退/中断/未实现该回调的 client）。
  const deltas: string[] = []
  const blocks: string[] = []
  let error: Error | undefined
  let stopReason = ''

  await client.stream(
    request,
    {
      onTextDelta: (text) => { deltas.push(text) },
      onThinkingDelta: () => { /* vision models rarely stream reasoning; ignore */ },
      onContentBlock: (block) => {
        if (block.type === 'text' && block.text) blocks.push(block.text)
      },
      onStreamAttemptAborted: info => { if (info.usage) options.recordUsage?.(info.usage) },
      onStopReason: (reason, usage) => { stopReason = reason; options.recordUsage?.(usage) },
      onError: (err) => { error = err },
    },
    options.signal,
  )

  if (error) { options.onOutcome?.({ complete: false, reason: 'error' }); throw error }
  const text = blocks.length > 0 ? blocks.join('') : deltas.join('')
  const complete = !!text.trim() && ['stop', 'end_turn', 'stop_sequence'].includes(stopReason)
  options.onOutcome?.({ complete, reason: !text.trim() ? 'empty' : complete ? 'completed' : `stop:${stopReason || 'unknown'}` })
  return (!complete && text.trim() ? `${text}\n[图片描述被截断]` : text).trim()
}
