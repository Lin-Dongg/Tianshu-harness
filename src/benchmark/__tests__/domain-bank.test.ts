import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { domainBankSchema, toPilotSuite, type DomainBankTask } from '../domain-bank.js'
import { loadTaskSuite } from '../task-suite.js'

/** 随仓题库（benchmark/domains/star-domain-eval-bank.json）——本测试是它的机读守卫。 */
const BANK_PATH = fileURLToPath(new URL('../../../benchmark/domains/star-domain-eval-bank.json', import.meta.url))

function loadRaw(): unknown {
  return JSON.parse(readFileSync(BANK_PATH, 'utf8'))
}

/**
 * 契约冻结守卫的判据（单一事实源：真题库守卫与合成用例共用同一函数，
 * 回退成「只查 validated」时合成用例必须红）。
 * candidate 免查：grader 还是 TBD，没有参考测试可冻结；validated/ready 已有
 * 真实契约（RED 基线已确认），必须冻结。判据写成 `!== 'candidate'` 而非枚举两态——
 * 新状态默认纳入守卫（宁多查不漏查）。
 */
function contractFreezeViolations(tasks: DomainBankTask[]): DomainBankTask[] {
  return tasks.filter(t => t.status !== 'candidate' && t.contractGiven && t.grader.mustNotTouch.length === 0)
}

describe('星域评测题库（domain bank）', () => {
  it('随仓题库文件存在且通过 schema 校验', () => {
    const bank = domainBankSchema.parse(loadRaw())
    assert.ok(bank.tasks.length >= 2, `题库至少应含 2 题，实际 ${bank.tasks.length}`)
  })

  it('id 全局唯一', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const ids = bank.tasks.map(t => t.id)
    assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.join(', ')}`)
  })

  it('validated / ready 条目必须给全 ground truth（oracleCommit + 评分命令 + 参考测试 + 证据）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks.filter(x => x.status === 'validated' || x.status === 'ready')) {
      assert.ok(t.environment.oracleCommit, `${t.id}: ${t.status} 必须带 environment.oracleCommit`)
      assert.ok(t.grader.command, `${t.id}: ${t.status} 必须带评分命令`)
      assert.ok(t.grader.referenceTests.length > 0, `${t.id}: ${t.status} 必须列出参考测试`)
      assert.ok(t.provenance.evidence.length > 0, `${t.id}: ${t.status} 必须留证据`)
    }
  })

  it('每题必须显式声明 contractGiven（防把「契约已给」的题当能力对比）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks) {
      assert.equal(typeof t.contractGiven, 'boolean', `${t.id}: contractGiven 必须显式声明`)
    }
  })

  it('契约已给（contractGiven=true）的 validated/ready 题，必须冻结参考测试（否则给了契约还能改测试）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const violations = contractFreezeViolations(bank.tasks)
    assert.deepEqual(
      violations.map(t => t.id),
      [],
      violations.map(t => `${t.id}: 契约已给却不冻结参考测试——agent 可改测试骗绿`).join('\n'),
    )
  })

  it('契约冻结守卫覆盖 ready 态（回归：此前只查 validated，ready+contractGiven=true+空 mustNotTouch 会漏过）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const base = bank.tasks[0]!
    const synthetic: DomainBankTask = {
      ...base,
      id: 'synthetic-ready-contract-violation',
      status: 'ready',
      contractGiven: true,
      grader: { ...base.grader, mustNotTouch: [] },
      validatedRuns: [],
    }
    const violations = contractFreezeViolations([synthetic]).map(t => t.id)
    assert.deepEqual(violations, ['synthetic-ready-contract-violation'], 'ready 态契约违规必须被守卫抓住')
  })

  it('validated 必须附真跑记录（ready 没有——没跑过就不许当真）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks) {
      if (t.status === 'validated') assert.ok(t.validatedRuns.length > 0, `${t.id}: validated 必须附 validatedRuns`)
      else assert.equal(t.validatedRuns.length, 0, `${t.id}: ${t.status} 不该有 validatedRuns`)
    }
  })

  it('candidate 条目不得自称已验证（不许贴金）', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks.filter(x => x.status === 'candidate')) {
      assert.equal(t.validatedRuns.length, 0, `${t.id}: candidate 不该有 validatedRuns`)
    }
  })

  it('题面（symptom）不得泄露修法：不含 diff/oracle 提交号', () => {
    const bank = domainBankSchema.parse(loadRaw())
    for (const t of bank.tasks) {
      assert.doesNotMatch(t.symptom, /\b[0-9a-f]{9}\b/, `${t.id}: 题面含疑似提交号，会剧透`)
    }
  })

  it('toPilotSuite 投影出 runner 可消费的 {tasks:[...]} 且字段齐备', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const suite = toPilotSuite(bank, { status: 'validated' })
    assert.ok(suite.tasks.length >= 1)
    for (const t of suite.tasks) {
      assert.ok(t.id && t.title && t.prompt && t.timeoutMs > 0)
    }
  })

  it('toPilotSuite 投影携带 contractGiven（禁作能力对比标记），且经 loadTaskSuite schema 回读不丢', () => {
    const bank = domainBankSchema.parse(loadRaw())
    const suite = toPilotSuite(bank)
    assert.equal(suite.tasks.length, bank.tasks.length)
    const byId = new Map(bank.tasks.map(t => [t.id, t]))
    for (const t of suite.tasks) {
      assert.equal(typeof t.contractGiven, 'boolean', `${t.id}: 投影必须带 contractGiven`)
      assert.equal(t.contractGiven, byId.get(t.id)!.contractGiven, `${t.id}: 投影不得改写 contractGiven`)
    }
    // schema 同步守卫：zod 默认剥未知 key——taskDefinitionSchema 不声明该字段时，
    // 写盘再经 loadTaskSuite 读回标记即丢失（下游机读止步于题库层的根因）。
    const dir = mkdtempSync(join(tmpdir(), 'pilot-suite-'))
    try {
      const suitePath = join(dir, 'suite.json')
      writeFileSync(suitePath, JSON.stringify(suite, null, 2))
      const loaded = loadTaskSuite(suitePath)
      assert.equal(loaded.tasks.length, suite.tasks.length)
      for (const t of loaded.tasks) {
        assert.equal(t.contractGiven, byId.get(t.id)!.contractGiven, `${t.id}: loadTaskSuite 回读后 contractGiven 不得丢失`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
