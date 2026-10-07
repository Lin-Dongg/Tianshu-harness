import { it } from 'node:test'
import assert from 'node:assert/strict'
import { runVerification } from './helpers/verification-pipeline-fixture.js'

it('snapshot omissions reach the model through the real pipeline on passing and failing runs', async () => {
  for (const fail of [false, true]) {
    const result = await runVerification('bad.test.mjs', fail, false, {
      tool: 'run_tests', snapshot: { omittedDirtyFiles: ['generated.ts'] },
    })
    assert.deepEqual(result.capturedParams?.verificationSnapshot?.omittedDirtyFiles, ['generated.ts'])
    assert.equal(result.actual.isError, fail)
    assert.match(result.actual.content, /generated\.ts/)
    assert.match(result.emittedContent, /generated\.ts/)
    assert.match(result.emittedContent, /隔离结果可能不反映它们的改动/)
    assert.equal(result.pipelineResult.toolResult.type, 'tool_result')
    if (result.pipelineResult.toolResult.type !== 'tool_result') assert.fail('expected tool result')
    assert.match(result.pipelineResult.toolResult.content, /generated\.ts/)
    if (fail) {
      assert.match(result.emittedContent, /阶段 B.*跳过/)
      assert.equal(result.actual.extraVerifications, undefined)
      assert.notEqual(result.verification.status, 'passed')
    }
  }
})

it('C3 retry preserves snapshot omissions and shows them when both environments fail', async () => {
  const result = await runVerification('bad.test.mjs', true, false, {
    tool: 'run_tests', snapshot: { omittedDirtyFiles: ['generated.ts'], retry: true },
  })
  assert.equal(result.capturedParams?.verificationSnapshot, undefined)
  assert.match(result.actual.content, /generated\.ts/)
  assert.match(result.emittedContent, /C3 归因重试/)
  assert.match(result.emittedContent, /generated\.ts/)
  assert.equal(result.actual.isError, true)
  assert.equal(result.actual.extraVerifications?.[0]?.verificationPhase, 'isolated')
})

it('snapshot omissions survive artifact interception before the model receives the result', async () => {
  const result = await runVerification('good.test.mjs', false, false, {
    tool: 'run_tests', artifactize: true, snapshot: { omittedDirtyFiles: ['generated.ts'] },
  })
  assert.match(result.emittedContent, /\[artifact:/, 'fixture must exercise output replacement')
  assert.match(result.emittedContent, /generated\.ts/)
  assert.equal(result.pipelineResult.toolResult.type, 'tool_result')
  if (result.pipelineResult.toolResult.type !== 'tool_result') assert.fail('expected tool result')
  assert.match(result.pipelineResult.toolResult.content, /generated\.ts/)
  assert.equal(result.verification.status, 'passed')
})
