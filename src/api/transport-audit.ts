import { beginCallAudit, type CallAuditContext, type CallAuditRecord } from './call-audit.js'

/** Observe consumed chunks without buffering a second stream or changing bytes. */
export function observeAuditResponse(response: Response, context: CallAuditContext, audit = beginCallAudit(context)): Response {
  if (!response.ok || !response.body) { audit.finish({ status: response.ok ? 'complete' : 'failed' }); return response }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = ''
  const facts: Pick<CallAuditRecord, 'responseId' | 'responseModel' | 'systemFingerprint' | 'finishReason' | 'usage'> = {}
  const observe = (line: string) => {
    try {
      const parsed = JSON.parse(line.startsWith('data:') ? line.slice(5).trim() : line)
      const data = parsed.response ?? parsed.message ?? parsed
      if (typeof data.id === 'string') facts.responseId = data.id
      if (typeof data.model === 'string') facts.responseModel = data.model
      if (typeof data.system_fingerprint === 'string') facts.systemFingerprint = data.system_fingerprint
      const reason = data.choices?.[0]?.finish_reason ?? data.stop_reason ?? parsed.delta?.stop_reason
      if (typeof reason === 'string') facts.finishReason = reason
      if (data.usage || parsed.usage) {
        const usage = data.usage ?? parsed.usage
        facts.usage = { ...facts.usage, ...usage,
          ...(typeof usage.input_tokens_details?.cached_tokens === 'number' ? { cache_read_input_tokens: usage.input_tokens_details.cached_tokens } : {}),
          ...(typeof usage.output_tokens_details?.reasoning_tokens === 'number' ? { reasoning_tokens: usage.output_tokens_details.reasoning_tokens } : {}) }
      }
    } catch { /* unknown SSE events have no accounting facts */ }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) { observe(pending + decoder.decode()); audit.finish({ ...facts, status: 'complete' }); controller.close(); return }
        pending += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) { observe(pending.slice(0, newline)); pending = pending.slice(newline + 1) }
        if (pending.length > 65536) pending = ''
        controller.enqueue(value)
      } catch (error) { audit.finish({ ...facts, status: 'aborted', errorName: (error as Error).name }); controller.error(error) }
    },
    async cancel(reason) { audit.finish({ ...facts, status: 'aborted' }); await reader.cancel(reason) },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
