import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRetryToolFailure } from '../retry-policy.js'

test('allows retry for transient failure on concurrency-safe read tool', () => {
  const result = shouldRetryToolFailure({
    toolName: 'read_file',
    failureClass: 'timeout',
    isConcurrencySafe: true,
    retryableClasses: ['timeout', 'flaky'],
    retriesRemaining: 1,
  })

  assert.equal(result.retry, true)
})

test('blocks retry for transient failure on unsafe bash tool', () => {
  const result = shouldRetryToolFailure({
    toolName: 'bash',
    failureClass: 'timeout',
    isConcurrencySafe: false,
    retryableClasses: ['timeout', 'flaky'],
    retriesRemaining: 1,
  })

  assert.equal(result.retry, false)
  assert.match(result.reason, /not concurrency-safe/)
})

test('blocks retry for write and edit tools even when marked safe', () => {
  for (const toolName of ['write_file', 'edit_file']) {
    const result = shouldRetryToolFailure({
      toolName,
      failureClass: 'timeout',
      isConcurrencySafe: true,
      retryableClasses: ['timeout'],
      retriesRemaining: 1,
    })

    assert.equal(result.retry, false)
    assert.match(result.reason, /non-idempotent/)
  }
})

test('blocks retry when failure class is not configured as retryable', () => {
  const result = shouldRetryToolFailure({
    toolName: 'read_file',
    failureClass: 'assertion',
    isConcurrencySafe: true,
    retryableClasses: ['timeout'],
    retriesRemaining: 1,
  })

  assert.equal(result.retry, false)
  assert.match(result.reason, /not retryable/)
})

test('blocks auto-retry for deliver_task even when failure class is transient (issue #356)', () => {
  const result = shouldRetryToolFailure({
    toolName: 'deliver_task',
    failureClass: 'timeout', // 模拟被文本正则误判的结果——policy 层必须独立拦截
    isConcurrencySafe: true,
    retryableClasses: ['timeout', 'flaky'],
    retriesRemaining: 2,
  })

  assert.equal(result.retry, false)
  assert.match(result.reason, /non-idempotent/)
})
