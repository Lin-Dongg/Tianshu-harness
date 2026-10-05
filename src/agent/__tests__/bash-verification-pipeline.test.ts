import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessImpactedTestCoverage } from '../verification-attribution.js'
import { runVerification } from './helpers/verification-pipeline-fixture.js'

describe('real bash verification pipeline', () => {
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
