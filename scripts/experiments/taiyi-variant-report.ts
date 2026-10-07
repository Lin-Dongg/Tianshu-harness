#!/usr/bin/env tsx
/**
 * 太一变体 pilot 汇总器——读 run JSONL，出 markdown 对照表。
 * 用法：npx tsx scripts/experiments/taiyi-variant-report.ts --store <runs.jsonl>
 */
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { values } = parseArgs({ options: { store: { type: 'string' } }, strict: false })
const storePath = resolve(typeof values.store === 'string' ? values.store : 'docs/experiments/2026-10-07-taiyi-pilot-runs.jsonl')

interface Row {
  variant: string
  taskId: string
  status: string
  turns: number
  toolCalls: number
  readOnlyToolCalls: number
  readOnlyRatio: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  thinkingChars: number
  textChars: number
  postureHits: { guardBlack: number; observeReturn: number; evidence: number }
  variantBlockChars: number
  durationMs: number
  toolSequence: string[]
  toolDetail?: string[]
  diffStat?: string
  gradeExit?: number
  gradeTail?: string
}

const rows: Row[] = readFileSync(storePath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const f = (n: number, d = 1) => n.toFixed(d)
const variants = [...new Set(rows.map(r => r.variant))].sort()

console.log(`# 太一变体 pilot 汇总（n=${rows.length}）\n`)
console.log('## 逐次明细\n')
console.log('| 变体 | 任务 | 状态 | turns | tools | 只读 | 只读比 | in | out | cacheR | 思考字 | 输出字 | 守黑 | 观复 | 取证 | 块字 | 秒 |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(
    `| ${r.variant} | ${r.taskId} | ${r.status} | ${r.turns} | ${r.toolCalls} | ${r.readOnlyToolCalls} | ` +
    `${f(r.readOnlyRatio, 2)} | ${r.tokensInput} | ${r.tokensOutput} | ${r.tokensCacheRead} | ${r.thinkingChars} | ${r.textChars} | ` +
    `${r.postureHits.guardBlack} | ${r.postureHits.observeReturn} | ${r.postureHits.evidence} | ${r.variantBlockChars} | ${f(r.durationMs / 1000)} |`,
  )
}

console.log('\n## 分组均值\n')
console.log('| 指标 | ' + variants.join(' | ') + ' |')
console.log('|---|' + variants.map(() => '---').join('|') + '|')
const metric = (name: string, pick: (r: Row) => number) => {
  const cells = variants.map(v => f(mean(rows.filter(r => r.variant === v).map(pick)), 2))
  console.log(`| ${name} | ${cells.join(' | ')} |`)
}
metric('turns', r => r.turns)
metric('tools', r => r.toolCalls)
metric('只读比', r => r.readOnlyRatio)
metric('in tokens', r => r.tokensInput)
metric('out tokens', r => r.tokensOutput)
metric('思考字', r => r.thinkingChars)
metric('输出字', r => r.textChars)
metric('守黑命中', r => r.postureHits.guardBlack)
metric('观复命中', r => r.postureHits.observeReturn)
metric('取证命中', r => r.postureHits.evidence)
metric('秒', r => r.durationMs / 1000)

console.log('\n## 结果与轨迹（逐次）\n')
for (const r of rows) {
  const grade = r.gradeExit === undefined ? '(未评分)' : r.gradeExit === 0 ? '**PASS**' : `**FAIL**(exit ${r.gradeExit})`
  console.log(`\n### ${r.variant} / ${r.taskId} — 评分 ${grade} · ${r.turns} turns / ${r.toolCalls} tools · ${(r.durationMs / 1000).toFixed(0)}s\n`)
  if (r.gradeTail) console.log('评分输出尾:\n```\n' + r.gradeTail + '\n```\n')
  console.log('工作区改动:\n```\n' + (r.diffStat || '(无改动)') + '\n```\n')
  const chain = (r.toolDetail && r.toolDetail.length ? r.toolDetail : r.toolSequence).join(' → ')
  console.log('轨迹（工具调用链）:\n\n' + chain + '\n')
}
