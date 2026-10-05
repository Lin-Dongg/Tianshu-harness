import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBashVerification, inferBashVerificationScope } from '../bash-verification.js'

describe('bash verification facts', () => {
  it('preserves domain failure exit codes even when the command executed normally', () => {
    const result = { content: 'AssertionError', isError: false, exitCode: 1 }
    const verification = buildBashVerification('node --test src/cache.test.mjs', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.exitCode, 1)
    assert.equal(verification.failureKind, 'test_failure')
    assert.equal(verification.scope, 'targeted')
    assert.deepEqual(verification.targetFiles, ['src/cache.test.mjs'])
  })

  it('does not fabricate a successful exit when the tool returned no exit code', () => {
    const result = { content: 'still running', isError: false }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'blocked')
    assert.equal(verification.exitCode, undefined)
  })

  it('keeps timeouts distinct from failed test assertions', () => {
    const result = { content: 'timed out', isError: true, exitCode: -1, errorClass: 'timeout' as const }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.exitCode, -1)
    assert.equal(verification.failureKind, 'timeout')
  })

  it('uses the successful retry result instead of an earlier harness error class', () => {
    const result = { content: '# pass 1\n# fail 0', isError: false, exitCode: 0 }
    const verification = buildBashVerification('npm test', result, { ...result, errorClass: 'timeout' })
    assert.equal(verification.status, 'passed')
    assert.equal(verification.exitCode, 0)
    assert.equal(verification.failureKind, undefined)
  })

  it('rejects a contradictory successful exit with failed TAP assertions', () => {
    const result = { content: '# pass 3\n# fail 1\n# skipped 2', isError: false, exitCode: 0 }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.passed, 3)
    assert.equal(verification.failed, 1)
    assert.equal(verification.skipped, 2)
  })
})

describe('bash verification scope', () => {
  it('allows known unfiltered suite invocations', () => {
    for (const command of ['npm test', 'npm run typecheck', 'npx tsc --noEmit', 'node --test', 'npx vitest run']) {
      assert.equal(inferBashVerificationScope(command).scope, 'full', command)
    }
  })

  it('does not extend selected files, test names or shell chains to full coverage', () => {
    for (const command of ['npm test -- src/cache.test.ts', 'pytest -k cache', 'node --test --test-name-pattern cache',
      'node --test src/cache.test.ts --test-name-pattern cache', 'pytest tests/test_cache.py -k cache',
      'npx jest src/cache.test.ts --testNamePattern=cache',
      'npm test && echo done', 'npm test || true', 'cd nested && npm test', 'npm run custom-verify']) {
      assert.equal(inferBashVerificationScope(command).scope, command === 'npm test -- src/cache.test.ts' ? 'targeted' : 'unknown', command)
    }
  })

  it('preserves quoted file targets and Windows executable paths', () => {
    assert.deepEqual(inferBashVerificationScope('node --test "src/cache manager.test.mjs"'), {
      scope: 'targeted', kind: 'test', targetFiles: ['src/cache manager.test.mjs'],
    })
    assert.equal(inferBashVerificationScope('"C:\\Program Files\\nodejs\\node.exe" --test').scope, 'full')
  })

  it('区分验证种类：test 类才是测试覆盖，typecheck/lint/build/check 只是检查（8784b64b8 审查 P3）', () => {
    // test 类：scope='full' + kind='test' —— 覆盖算法唯一采信的形态
    for (const command of ['npm test', 'node --test', 'npx vitest run']) {
      const r = inferBashVerificationScope(command)
      assert.equal(r.scope, 'full', command)
      assert.equal(r.kind, 'test', command)
    }
    // 检查类：scope 仍为 'full'（status 判据 scope !== 'unknown' 不变，成功仍记 passed），
    // 但 kind 非 test —— 不得清空 impacted-test 未覆盖列表
    assert.deepEqual(inferBashVerificationScope('npm run typecheck'), { scope: 'full', kind: 'typecheck' })
    assert.deepEqual(inferBashVerificationScope('npx tsc --noEmit'), { scope: 'full', kind: 'typecheck' })
    assert.deepEqual(inferBashVerificationScope('npm run build'), { scope: 'full', kind: 'build' })
    assert.deepEqual(inferBashVerificationScope('npm run lint'), { scope: 'full', kind: 'lint' })
    assert.deepEqual(inferBashVerificationScope('cargo check'), { scope: 'full', kind: 'check' })
  })
})

it('pipeline success cannot attest to the hidden test process and later batches retain failures', () => {
  const hidden = { content: 'filtered text', isError: false, exitCode: 0 }
  assert.equal(buildBashVerification('npm test | tail -5', hidden, hidden).status, 'blocked')
  const mixed = { content: '# pass 2\n# fail 0\n# pass 3\n# fail 1', isError: false, exitCode: 0 }
  const result = buildBashVerification('npm test', mixed, mixed)
  assert.equal(result.status, 'failed'); assert.equal(result.failed, 1); assert.equal(result.passed, 5)
})
