/**
 * 内联推理标签的剥离。
 *
 * 背景（2026-10-06 外部用户会话 2026100677724c4ca112）：部分 DeepSeek 系中转把推理
 * 正文直接内联在 content 里、以 `</think>` 收尾；而 tianshu 只从 `delta.reasoning_content`
 * 取推理，于是这个**孤立的结束标签**被当正文一路 persist——182 条记录中 13 条命中，
 * 其中 6 条出现在 content 第 0 位（`</think>好，这次 grep 返回了。`）。
 *
 * 本模块只「剥标签」，**不搬移推理正文**：实时增量与最终 content block 必须字符一致，
 * 否则界面会先显示一段推理、回合结束时又被 thinking 通道重放一遍。把推理正文改判为
 * thinking 是另一个产品决策，需要配套的流式扣留策略，不在本模块职责内。
 *
 * 只认完整标签 `</?think\s*>`：刻意不匹配 `<thinking>`——那是 anthropic-client 在出站
 * 报文里主动构造的标记（src/api/anthropic-client.ts:474），剥掉会毁掉真实内容。
 *
 * @module inline-reasoning
 */

const THINK_TAG_RE = /<\/?think\s*>/g

/**
 * 尾部「可能是一个未完成 think 标签」的最长后缀。带 `/` 与可选 `>`，因此
 * `<`、`</`、`</t`…`</think`、`</think>` 都算，而 `<b` 不算。
 */
const TAG_PREFIX_TAIL_RE = /<(?:\/?(?:t(?:h(?:i(?:n(?:k\s*>?)?)?)?)?))?$/

/** 从完整文本里剥掉 think 标签（权威路径：落盘与展示的 content block 用它）。 */
export function stripThinkTags(text: string): string {
  return text.includes('<') ? text.replace(THINK_TAG_RE, '') : text
}

/**
 * 流式增量过滤：吞入一个增量，返回可安全外发的文本与仍需继续扣住的尾部。
 *
 * 扣住的是「可能是标签开头」的尾巴，所以被拆到多个增量里的标签一个字符也漏不出去；
 * 代价是尾部最多几字节的延迟（确认不是标签后立即原样放行）。
 */
export function filterThinkTagDelta(hold: string, delta: string): { hold: string; out: string } {
  let buf = hold + delta
  if (buf.includes('<')) buf = buf.replace(THINK_TAG_RE, '')
  const tail = TAG_PREFIX_TAIL_RE.exec(buf)
  if (tail && tail[0]) return { hold: tail[0], out: buf.slice(0, buf.length - tail[0].length) }
  return { hold: '', out: buf }
}

/** 流结束时冲刷扣留窗口：未完成的标签前缀直接丢弃，不当作正文外发。 */
export function flushThinkTagHold(hold: string): string {
  return TAG_PREFIX_TAIL_RE.test(hold) ? '' : hold
}
