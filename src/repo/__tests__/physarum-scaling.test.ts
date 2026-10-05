import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PhysarumEngine } from '../physarum-engine.js'
import { DEFAULT_PHYSARUM_CONFIG, type PhysarumEdgeState } from '../physarum-types.js'
import type { MeridianDb } from '../meridian-db.js'

// Compatibility oracle: the previous per-node full-graph scaling. A graph's
// insertion order determines the order of floating-point multiplications.
function previousScaling(edges: PhysarumEdgeState[], budget: number): void {
  const totals = new Map<string, number>()
  for (const edge of edges) {
    totals.set(edge.fileA, (totals.get(edge.fileA) ?? 0) + edge.weight)
    totals.set(edge.fileB, (totals.get(edge.fileB) ?? 0) + edge.weight)
  }
  for (const [node, total] of totals) {
    if (total <= budget) continue
    for (const edge of edges) {
      if (edge.fileA === node || edge.fileB === node) edge.weight *= budget / total
    }
  }
}

test('batch scaling preserves exact weights, predictions and per-node budgets on an overlapping dense graph', () => {
  const edges: PhysarumEdgeState[] = []
  for (let i = 0; i < 180; i++) {
    for (let hop = 1; hop <= 12; hop++) {
      const pair = [`src/module-${i}.ts`, `src/module-${(i + hop) % 180}.ts`].sort()
      edges.push({ fileA: pair[0]!, fileB: pair[1]!, weight: 1 + (i % 17) / 7 + hop / 13,
        flow: 0, activationCount: 5, consolidated: true, lastActivatedTurn: 1, direction: 0 })
    }
  }
  const expected = edges.map(edge => ({ ...edge }))
  const budget = 10
  previousScaling(expected, budget)
  const db = { loadPhysarumEdges: () => edges } as unknown as MeridianDb
  const graph = new PhysarumEngine(db, { ...DEFAULT_PHYSARUM_CONFIG, growthRate: 0, synapticBudget: budget })
  graph.loadFromDb()
  assert.equal(graph.edgeCount(), expected.length)
  graph.batchEvolve(1)
  const totals = new Map<string, number>()
  for (const edge of expected) {
    assert.equal(graph.getEdge(edge.fileA, edge.fileB)?.weight, edge.weight)
    for (const node of [edge.fileA, edge.fileB]) totals.set(node, (totals.get(node) ?? 0) + edge.weight)
  }
  assert.ok([...totals.values()].every(total => total <= budget + 1e-12))
  const source = 'src/module-0.ts'
  const expectedPredictions = expected.filter(edge => edge.fileA === source || edge.fileB === source)
    .map(edge => ({ file: edge.fileA === source ? edge.fileB : edge.fileA, score: edge.weight }))
    .sort((a, b) => b.score - a.score).slice(0, 3)
  assert.deepEqual(graph.predictNext(source, 3), expectedPredictions)
})

test('directly recorded self-edges are scaled once, matching the previous algorithm', () => {
  const graph = new PhysarumEngine(undefined, { ...DEFAULT_PHYSARUM_CONFIG, growthRate: 0, synapticBudget: 0.5 })
  graph.recordFlow('src/a.ts', 'src/a.ts', 1)
  graph.batchEvolve(1)
  assert.equal(graph.getEdge('src/a.ts', 'src/a.ts')?.weight, 0.25)
})

// 补优化（超出 PR #351 原文范围）：applyUbiquityPenalty 与 homeostatic 缩放
// 同瓶颈（O(V·E) per-node 全表扫描，immune-hook 生产在调），以同一两遍模式
// 线性化。oracle 复刻旧算法做逐位对照。
function previousUbiquity(edges: PhysarumEdgeState[], threshold: number): void {
  const totalNodes = new Set<string>()
  const nodeConnections = new Map<string, number>()
  for (const edge of edges) {
    totalNodes.add(edge.fileA)
    totalNodes.add(edge.fileB)
    nodeConnections.set(edge.fileA, (nodeConnections.get(edge.fileA) ?? 0) + 1)
    nodeConnections.set(edge.fileB, (nodeConnections.get(edge.fileB) ?? 0) + 1)
  }
  const n = totalNodes.size
  if (n === 0) return
  for (const [node, connections] of nodeConnections) {
    const ratio = connections / n
    if (ratio <= threshold) continue
    const penalty = 1 / (1 + Math.log(ratio / threshold))
    for (const edge of edges) {
      if (edge.fileA === node || edge.fileB === node) edge.weight *= penalty
    }
  }
}

test('ubiquity penalty preserves exact weights across an overlapping dense graph', () => {
  const edges: PhysarumEdgeState[] = []
  for (let i = 0; i < 180; i++) {
    for (let hop = 1; hop <= 12; hop++) {
      const pair = [`src/module-${i}.ts`, `src/module-${(i + hop) % 180}.ts`].sort()
      edges.push({ fileA: pair[0]!, fileB: pair[1]!, weight: 1 + (i % 17) / 7 + hop / 13,
        flow: 0, activationCount: 5, consolidated: true, lastActivatedTurn: 1, direction: 0 })
    }
  }
  const expected = edges.map(edge => ({ ...edge }))
  previousUbiquity(expected, 0.05)
  const db = { loadPhysarumEdges: () => edges } as unknown as MeridianDb
  const graph = new PhysarumEngine(db, { ...DEFAULT_PHYSARUM_CONFIG, growthRate: 0, ubiquityThreshold: 0.05 })
  graph.loadFromDb()
  graph.applyUbiquityPenalty()
  for (const edge of expected) {
    assert.equal(graph.getEdge(edge.fileA, edge.fileB)?.weight, edge.weight)
  }
})
