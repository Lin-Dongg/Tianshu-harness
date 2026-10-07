import { readFileSync, writeFileSync } from 'node:fs'
import { domainBankSchema, toPilotSuite } from '../../src/benchmark/domain-bank.js'

// 题库 → runner suite（端到端走一遍投影器；README 声称可用，这里实测）
const bank = domainBankSchema.parse(JSON.parse(readFileSync('benchmark/domains/star-domain-eval-bank.json', 'utf8')))
const id = process.argv[2]
if (!id) throw new Error('用法: tsx .rivet/scratch/gen-suite.ts <taskId>')
const suite = toPilotSuite(bank, { ids: [id] })
if (suite.tasks.length === 0) throw new Error(`题库无此 id: ${id}`)
const out = `/tmp/suite-${id}.json`
writeFileSync(out, JSON.stringify(suite, null, 2))
console.log(`写出 ${out} · tasks=${suite.tasks.map(t => t.id).join(',')} · category=${suite.tasks[0]!.category} · timeoutMs=${suite.tasks[0]!.timeoutMs}`)
