import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessImpactedTestCoverage } from '../verification-attribution.js'
import { runVerification } from './helpers/verification-pipeline-fixture.js'

describe('real bash verification pipeline', () => {
  it('returns compound-shell guidance to the model and UI without claiming failure or coverage', async () => {
    const result = await runVerification('node --test good.test.mjs | tail -5', false)
    assert.equal(result.verification.status, 'blocked')
    assert.equal(result.ledgerEvent.status, 'blocked')
    assert.equal(result.verification.coverage?.complete ?? false, false)
    assert.equal(result.pipelineResult.toolResult.type, 'tool_result')
    if (result.pipelineResult.toolResult.type !== 'tool_result') assert.fail('expected tool result')
    const content = result.pipelineResult.toolResult.content
    assert.match(content, /可复制的单条命令：node --test good\.test\.mjs/)
    assert.match(content, /不能据此认定测试失败/)
    assert.match(result.emittedContent, /可复制的单条命令：node --test good\.test\.mjs/)
  })

  it('keeps package and node queries out of the foreground verification ledger', async () => {
    for (const command of ['npm --version', 'node -e "console.log(1)"']) {
      const result = await runVerification(command, false)
      assert.equal(result.actual.exitCode, 0)
      assert.equal(result.ledger.getVerifications().length, 0, command)
      assert.doesNotMatch(result.emittedContent, /\[验证反馈\]/)
    }
  })

  it('blocks delivery after actual targeted assertion failure with isError=false', async () => {
    const result = await runVerification('node --test bad.test.mjs', true, true)
    assert.equal(result.actual.isError, false, 'normal execution is distinct from assertion success')
    assert.equal(result.actual.exitCode, 1)
    assert.equal(result.verification.exitCode, 1)
    assert.equal(result.verification.status, 'failed')
    assert.equal(result.ledgerEvent.meta?.exitCode, 1)
    assert.equal(result.ledgerEvent.status, 'failed')
    assert.equal(result.gate.state, 'RED')
    assert.equal(result.gate.canDeliver, false)
  })

  it('does not attribute an unowned targeted failure to owned files', async () => {
    const result = await runVerification('node --test bad.test.mjs', true)
    assert.equal(result.verification.status, 'failed')
    assert.equal(result.gate.state, 'YELLOW')
  })

  it('records actual full-suite failure without claiming verified delivery', async () => {
    const result = await runVerification('npm test', true)
    assert.equal(result.actual.exitCode, 1)
    assert.equal(result.verification.status, 'failed')
    assert.equal(result.verification.scope, 'full')
    assert.notEqual(result.gate.state, 'GREEN')
  })

  it('does not cover an unrun failing test with one actual successful targeted test', async () => {
    const result = await runVerification('node --test good.test.mjs', true)
    assert.equal(result.actual.exitCode, 0)
    assert.equal(result.verification.status, 'passed')
    assert.equal(result.verification.scope, 'targeted')
    assert.deepEqual(result.ledgerEvent.meta?.targetFiles, ['good.test.mjs'])
    assert.deepEqual(assessImpactedTestCoverage(['good.test.mjs', 'bad.test.mjs'], [result.verification], () => true), {
      uncovered: ['bad.test.mjs'], uncoverable: [],
    })
  })

  it('allows delivery after actual successful unfiltered node test execution', async () => {
    const result = await runVerification('node --test', false)
    assert.equal(result.actual.exitCode, 0)
    assert.equal(result.verification.status, 'passed')
    assert.equal(result.verification.scope, 'full')
    assert.equal(result.gate.state, 'GREEN')
    assert.equal(result.gate.canDeliver, true)
  })
})
