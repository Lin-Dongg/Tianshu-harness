import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'
import { isMeridianIndexablePath } from '../repo/meridian-indexer.js'
import { analyzeImpact, type ImpactResult, type ImpactStep } from '../repo/meridian-impact.js'
import { buildImportGraphAsync } from './import-graph.js'
import { isTestEntry as testPath } from '../repo/test-entry.js'

export interface DeliveryImpact extends Partial<ImpactResult> { resolved: boolean; reason?: string; requiredTests: string[]; advisoryTests: string[] }
const exec = promisify(execFile)

/** Recompute from current dirty ownership; history is diagnostic, never obligation. */
export async function resolveDeliveryImpact(cwd: string, files: readonly string[], indexer?: MeridianIndexer | null): Promise<DeliveryImpact> {
  if (!files.length) return { resolved: true, policyVersion: 1, requiredTests: [], advisoryTests: [], reasons: {} }
  try {
    if (indexer?.getDb().available) {
      // Checking only changed files misses a newly added importer. Reconcile the
      // existing indexable scope, without widening languages or traversal hops.
      const result = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      const current = new Set(result.stdout.split('\0').filter(path => path && isMeridianIndexablePath(path) && existsSync(resolve(cwd, path))))
      for (const path of indexer.getDb().getAllFiles()) if (!current.has(path)) indexer.removeFile(path)
      for (const path of current) {
        const source = readFileSync(resolve(cwd, path), 'utf8')
        if (/\bimport\b/.test(source) && !indexer.getDb().getSymbolsForFile(path).length) await indexer.invalidateFile(path)
        else await indexer.indexFile(path)
        const hash = createHash('sha256').update(readFileSync(resolve(cwd, path))).digest('hex').slice(0, 16)
        if (indexer.getDb().needsParse(path, hash)) throw new Error('index changed during reconciliation')
      }
      const impact = analyzeImpact(indexer.getDb(), [...files])
      if (!impact.requiredTests || !impact.advisoryTests) throw new Error('missing impact policy')
      return { ...impact, resolved: true, requiredTests: impact.requiredTests, advisoryTests: impact.advisoryTests }
    }
  } catch { /* An unavailable or stale index is not affirmative no-impact evidence. */ }
  try {
    if (files.some(path => /\.(?:py|go)$/.test(path))) throw new Error('fallback language unsupported')
    const graph = await buildImportGraphAsync(cwd, { requireComplete: true })
    if (!graph) throw new Error('static import graph incomplete')
    const required = new Set(files.filter(testPath))
    const reasons: Record<string, ImpactStep[]> = {}
    let frontier = files.map(path => ({ file: resolve(cwd, path), path: [] as ImpactStep[] }))
    const visited = new Set(frontier.map(item => item.file))
    for (let hop = 0; hop < 3; hop++) {
      const next: typeof frontier = []
      for (const item of frontier) for (const dependent of graph.reverse.get(item.file) ?? []) {
        if (visited.has(dependent)) continue
        visited.add(dependent)
        const path = relative(cwd, dependent).replaceAll('\\', '/')
        const proof = [...item.path, { from: relative(cwd, item.file).replaceAll('\\', '/'), to: path, kind: 'imports', confidence: 'extracted' }]
        next.push({ file: dependent, path: proof })
        if (testPath(path)) { required.add(path); reasons[path] = proof }
      }
      frontier = next
    }
    return { resolved: true, policyVersion: 1, requiredTests: [...required].sort(), advisoryTests: [], reasons }
  } catch {
    return { resolved: false, requiredTests: [], advisoryTests: [], reason: 'impact_unresolved: 索引与完整静态导入图均不可用。' }
  }
}
