/**
 * DSML 文本形态工具调用的恢复（网#2）。
 *
 * 背景（2026-10-06 线上会话 2026100677724c4ca112：182 条记录中 23 条命中）：
 * DeepSeek 系网关/中转会把工具调用以标记文本塞进 content，而不是结构化
 * tool_calls 字段。openai-client 的 JSON 兜底（网#1）只认 `{`/`[` 开头，
 * 于是这些调用蒸发成纯文本 → 本轮零 tool_call → 会话静默结束，用户看到
 * 「无缘无故停了」。既有 isReportChannelError 只看 worker 报告通道。
 *
 * 线上抓样（竖线为 U+FF5C 全角；部分网关用半角 |，两种都容忍）：
 *
 *   <｜DSML｜tool_calls>
 *     <｜DSML｜invoke name="edit_file">
 *       <｜DSML｜parameter name="file_path" string="true">lab.py</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * 命中条件刻意收紧为「tool_calls 开标记 + 至少一个完整 invoke」，避免把模型
 * 在正文里复述标记（讨论该格式、贴日志）误判成真实调用。
 */

export interface DsmlToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * 从累积正文里解析 DSML 工具调用。
 *
 * @param emit 每命中一个 invoke 调用一次。
 * @returns 剥掉标记区后的正文（周边散文照常展示，不因一处标记丢失整段）；
 *          未命中时返回 null，调用方据此保持原文不变。
 */
export function recoverDsmlToolCallsFromContent(
  text: string,
  emit: (block: DsmlToolUseBlock) => void,
): string | null {
  // 正则就地构造：带 g 标志的正则持有 lastIndex，模块级共享会在并发流之间串状态。
  const openMatch = /<[\uFF5C|]DSML[\uFF5C|]tool_calls\s*>/.exec(text)
  if (!openMatch) return null

  const invokeRe = /<[\uFF5C|]DSML[\uFF5C|]invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[\uFF5C|]DSML[\uFF5C|]invoke>/g
  const paramRe = /<[\uFF5C|]DSML[\uFF5C|]parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[\uFF5C|]DSML[\uFF5C|]parameter>/g

  let toolUses = 0
  let invoke: RegExpExecArray | null
  while ((invoke = invokeRe.exec(text)) !== null) {
    const name = invoke[1]!
    const input: Record<string, unknown> = {}
    paramRe.lastIndex = 0
    let param: RegExpExecArray | null
    while ((param = paramRe.exec(invoke[2]!)) !== null) {
      const key = param[1]!
      const rawValue = param[3]!
      // string="false" 表示结构化参数，按 JSON 解析；其余（含缺省）按字面量。
      if (param[2] === 'false') {
        try { input[key] = JSON.parse(rawValue) } catch { input[key] = rawValue }
      } else {
        input[key] = rawValue
      }
    }
    emit({ type: 'tool_use', id: `fallback_${name}_${toolUses}`, name, input })
    toolUses++
  }
  if (toolUses === 0) return null

  // 剥掉标记区：开标记 → 最后一个闭标记（模型漏发闭标记时到文末）。
  const closerRe = /<\/[\uFF5C|]DSML[\uFF5C|]tool_calls\s*>/g
  closerRe.lastIndex = openMatch.index
  let end = text.length
  let closer: RegExpExecArray | null
  while ((closer = closerRe.exec(text)) !== null) end = closer.index + closer[0].length
  return (text.slice(0, openMatch.index) + text.slice(end)).trim()
}
