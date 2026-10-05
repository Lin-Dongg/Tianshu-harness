import type { AgentLoop } from './loop.js'
import type { Usage } from '../api/types.js'
import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'

const pendingWrites = new WeakMap<AgentLoop, Set<Promise<void>>>()
export async function drainSidePathUsage(self: AgentLoop): Promise<void> {
  const pending = pendingWrites.get(self)
  while (pending?.size) await Promise.all([...pending])
}

export function createSidePathUsageRecorder(self: AgentLoop): (kind: string, usage: Partial<Usage>, model?: string, provider?: string) => void {
  return (kind, usage, model, provider) => {
    try {
      // Keep "all usage fields unknown" observations: an aborted attempt with
      // provider usage missing must still leave an identity-stamped cache-log
      // row. Only truly empty calls (no observation and no numeric field) are
      // dropped so they don't pollute totals/rate denominators.
      const hasNumericUsage = (usage.input_tokens ?? 0) > 0
        || (usage.output_tokens ?? 0) > 0
        || (usage.cache_read_input_tokens ?? 0) > 0
        || (usage.cache_creation_input_tokens ?? 0) > 0
        || (usage.reasoning_tokens ?? 0) > 0
      if (!hasNumericUsage && !usage.observation) return
      self.session.addSidePathUsage(usage)
      const input = usage.input_tokens ?? 0
      const hitRate = input > 0
        ? ((usage.cache_read_input_tokens ?? 0) / input * 100).toFixed(1)
        : '0.0'
      const line = JSON.stringify({
        event: 'side_path',
        ...usage.observation,
        usageFields: usage.observation?.fields,
          buildId: process.env.RIVET_BUILD_ID ?? 'unknown',
        kind,
        t: Date.now(),
        model: usage.observation?.wire?.model ?? model ?? 'unknown',
        // provider 维度（T3）：spark 与官方 deepseek 的 wire 模型 id 相同，
        // 无此字段两者在日志里无法区分。默认主会话 provider；专用 compact
        // client 等跨 provider 侧路由调用方显式传入。
        provider: usage.observation?.wire?.provider ?? provider ?? self.config.providerName,
        input: usage.input_tokens ?? null,
        cacheRead: usage.cache_read_input_tokens ?? null,
        cacheCreate: usage.cache_creation_input_tokens ?? null,
        output: usage.output_tokens ?? null,
        hitRate: usage.input_tokens && typeof usage.cache_read_input_tokens === 'number' ? `${hitRate}%` : null,
      })
      const sid = self.config.sessionId ?? 'anon'
      let pending = pendingWrites.get(self)
      if (!pending) { pending = new Set(); pendingWrites.set(self, pending) }
      const write = import('node:fs/promises').then(fs => {
        const dir = join(getSessionDir(self.cwd), sid)
        return fs.mkdir(dir, { recursive: true })
          .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
      }).catch(() => {}).finally(() => { pending!.delete(write) })
      pending.add(write)
    } catch { /* accounting is best-effort — never break the side path */ }
  }
}
