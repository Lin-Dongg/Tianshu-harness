import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { stableStringify } from '../api/stable-json.js'
import type { WorkOrder, WorkerResult } from './work-order.js'
import { parseWorkerResult } from './work-order.js'
import type { WorkerSessionConfig } from './worker-session.js'
import { coordinatorSubagentsDir } from './worker-result-store.js'

export function workerResultFingerprint(order: WorkOrder, config: WorkerSessionConfig): string | undefined {
  if (!config.providerName || !order.scope.files?.length || order.scope.files.length > 100) return undefined
  try {
    const root = realpathSync(config.cwd)
    let bytes = 0
    const files = [...order.scope.files].sort().map(file => {
      const path = realpathSync(resolve(root, file))
      const rel = relative(root, path)
      const size = statSync(path).size
      bytes += size
      if (rel.startsWith('..') || !rel || size > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error('unbounded reuse scope')
      return { path: rel, digest: createHash('sha256').update(readFileSync(path)).digest('hex') }
    })
    const key = { root, files, objective: order.objective, kind: order.kind, profile: order.profile, constraints: order.constraints,
      authority: order.authority, delivery: order.delivery, provider: config.providerName, model: config.promptEngine.getModel(), endpoint: config.baseUrl,
      tools: config.toolRegistry.getDefinitions(), approval: config.parentApprovalMode, reviewDepth: config.reviewDepth }
    return createHash('sha256').update(stableStringify(key)).digest('hex')
  } catch { return undefined }
}

export function tryReuseWorkerResult(fingerprint: string | undefined, nowMs: number): WorkerResult | null {
  if (!fingerprint) return null
  const path = join(coordinatorSubagentsDir(), `${fingerprint}.json`)
  if (!existsSync(path)) return null
  try {
    if (nowMs - statSync(path).mtimeMs > 3_600_000) return null
    const result = parseWorkerResult(readFileSync(path, 'utf8'), fingerprint)
    // Only source-backed results can be reused, never old provider-less fingerprints.
    if (result?.status === 'passed' && result.provider && result.model) return { ...result, summary: `[resumed] ${result.summary}` }
  } catch { /* stale/corrupt */ }
  return null
}
