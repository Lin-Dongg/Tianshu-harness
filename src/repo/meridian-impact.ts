import type { MeridianDb } from './meridian-db.js'
import { isTestEntry as isTestFile } from './test-entry.js'

export interface ImpactStep { from: string; to: string; kind: string; confidence?: string }
export interface ImpactResult {
  policyVersion?: 1
  requiredTests?: string[]
  advisoryTests?: string[]
  reasons?: Record<string, ImpactStep[]>
  /** Files that directly depend on the changed files */
  direct: string[]
  /** Files that transitively depend (2+ hops) */
  transitive: string[]
  /** Test files that should be run */
  tests: string[]
  /** Total unique impacted files */
  totalImpact: number
}

/**
 * Reverse BFS from changed files to find all dependents.
 * Walks edges backwards: "who imports/calls into these files?"
 */
export function analyzeImpact(
  db: MeridianDb,
  changedFiles: string[],
  opts?: { maxHops?: number },
): ImpactResult {
  const maxHops = opts?.maxHops ?? 3
  const direct = new Set<string>()
  const transitive = new Set<string>()
  const tests = new Set<string>()
  const changedSet = new Set(changedFiles)

  // Collect tests for changed files
  for (const file of changedFiles) {
    for (const t of db.getTestsFor(file)) {
      if (isTestFile(t)) tests.add(t)
    }
  }

  // Reverse BFS
  let frontier = new Set(changedFiles)
  const visited = new Set(changedFiles)

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>()

    for (const file of frontier) {
      const deps = db.getReverseDependents(file)
      for (const dep of deps) {
        if (visited.has(dep.file)) continue
        visited.add(dep.file)
        nextFrontier.add(dep.file)

        if (hop === 0) {
          direct.add(dep.file)
        } else {
          transitive.add(dep.file)
        }

        // Check if this dependent is a test file
        if (isTestFile(dep.file)) {
          tests.add(dep.file)
        }
      }
    }

    frontier = nextFrontier
    if (frontier.size === 0) break
  }

  // Also find tests via co-edit neighbors (behavioral signal)
  for (const file of changedFiles) {
    const coNeighbors = db.getCoEditNeighbors(file)
    for (const n of coNeighbors) {
      if (isTestFile(n.file) && !tests.has(n.file)) {
        tests.add(n.file)
      }
    }
  }

  // Traverse proof paths independently: a speculative predecessor never
  // promotes later extracted edges into mandatory obligations.
  const required = new Set<string>(changedFiles.filter(isTestFile))
  const reasons: Record<string, ImpactStep[]> = {}
  for (const file of required) reasons[file] = []
  let proofFrontier = changedFiles.map(file => ({ file, path: [] as ImpactStep[] }))
  const proofVisited = new Set(changedFiles)
  for (let hop = 0; hop < maxHops; hop++) {
    const next: typeof proofFrontier = []
    for (const { file, path } of proofFrontier) {
      for (const dep of db.getReverseDependents(file)) {
        if (dep.confidence !== 'extracted' || !['imports', 'calls'].includes(dep.kind) || proofVisited.has(dep.file)) continue
        proofVisited.add(dep.file)
        const proof = [...path, { from: file, to: dep.file, kind: dep.kind, confidence: dep.confidence }]
        next.push({ file: dep.file, path: proof })
        if (isTestFile(dep.file)) { required.add(dep.file); reasons[dep.file] = proof }
      }
    }
    proofFrontier = next
  }
  // Advisory explanations use the broad graph but never feed proof traversal.
  let advisoryFrontier = changedFiles.map(file => ({ file, path: [] as ImpactStep[] }))
  const advisoryVisited = new Set(changedFiles)
  for (let hop = 0; hop < maxHops; hop++) {
    const next: typeof advisoryFrontier = []
    for (const { file, path } of advisoryFrontier) for (const dep of db.getReverseDependents(file)) {
      if (advisoryVisited.has(dep.file)) continue
      advisoryVisited.add(dep.file)
      const explanation = [...path, { from: file, to: dep.file, kind: dep.kind, confidence: dep.confidence }]
      next.push({ file: dep.file, path: explanation })
      if (isTestFile(dep.file) && !required.has(dep.file)) reasons[dep.file] = explanation
    }
    advisoryFrontier = next
  }
  for (const file of changedFiles) {
    for (const test of db.getTestsFor(file)) if (isTestFile(test) && !reasons[test]) reasons[test] = [{ from: file, to: test, kind: 'tested_by', confidence: 'inferred' }]
    for (const neighbor of db.getCoEditNeighbors(file)) if (isTestFile(neighbor.file) && !reasons[neighbor.file]) reasons[neighbor.file] = [{ from: file, to: neighbor.file, kind: 'co_edit', confidence: 'inferred' }]
  }
  for (const test of required) tests.add(test)
  return {
    policyVersion: 1,
    requiredTests: [...required].sort(),
    advisoryTests: [...tests].filter(test => !required.has(test)).sort(),
    reasons,
    direct: [...direct],
    transitive: [...transitive],
    tests: [...tests],
    totalImpact: direct.size + transitive.size,
  }
}

/**
 * Infer tested_by edges for a file based on naming conventions.
 * Returns source file paths that this test file likely tests.
 */
export function inferTestedByTargets(testFilePath: string, allFiles: string[]): string[] {
  if (!isTestFile(testFilePath)) return []

  // Extract base name: src/__tests__/foo.test.ts → foo
  const baseName = testFilePath
    .replace(/.*[/\\]/, '')           // strip directory
    .replace(/\.(test|spec)\.[^.]+$/, '') // strip .test.ts
    .replace(/\.[^.]+$/, '')          // strip extension if no test suffix

  if (!baseName) return []

  // Find source files matching the base name
  return allFiles.filter(f => {
    if (f === testFilePath) return false
    if (isTestFile(f)) return false
    const fileName = f.replace(/.*[/\\]/, '').replace(/\.[^.]+$/, '')
    return fileName === baseName
  })
}
