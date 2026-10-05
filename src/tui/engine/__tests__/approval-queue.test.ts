import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import { wrapCallbacksWithTuiApp } from '../bridge.js'

const tick = () => new Promise<void>(r => setImmediate(r))

test('concurrent approvals preserve FIFO and settle every callback', async () => {
  const { app, stdin, out } = makeApp()
  try {
    const resolved: string[] = []
    const a = app.callbacks.onApprovalRequired('a', 'read_file', { file_path: '/outside/a' }).then(v => { resolved.push('a'); return v })
    const b = app.callbacks.onApprovalRequired('b', 'read_file', { file_path: '/outside/b' }).then(v => { resolved.push('b'); return v })
    assert.equal((app as any).approvalIntentController.approvalPending.id, 'a')
    assert.ok(stripAnsi(out.chunks.join('')).includes('还有 1 项待审批'))
    stdin.dataHandler!('y')
    assert.deepEqual(await a, { approved: true })
    assert.deepEqual(resolved, ['a'])
    stdin.dataHandler!('n')
    assert.equal(await b, false)
    assert.deepEqual(resolved, ['a', 'b'])
  } finally { app.dispose() }
})

test('first approval leaves help overlay and unfreezes output', async () => {
  const { app, stdin, out } = makeApp()
  try {
    app.activateOverlay('help')
    ;(app as any).setOutputFrozen(true)
    out.clear()
    const p = app.callbacks.onApprovalRequired('a', 'bash', { command: 'echo a' })
    assert.equal((app as any).overlay.activeId(), null)
    assert.equal((app as any).outputFrozen, false)
    assert.ok(stripAnsi(out.chunks.join('')).includes('等待审批 bash'))
    stdin.dataHandler!('y')
    assert.deepEqual(await p, { approved: true })
  } finally { app.dispose() }
})

test('new approvals preserve active editing and input draft', async () => {
  const { app, stdin } = makeApp()
  try {
    app.setInput('draft')
    const a = app.callbacks.onApprovalRequired('a', 'write_file', { file_path: '/a', content: 'original' })
    stdin.dataHandler!('e')
    const b = app.callbacks.onApprovalRequired('b', 'write_file', { file_path: '/b', content: 'second' })
    assert.equal((app as any).approvalIntentController.approvalPending.id, 'a')
    assert.equal((app as any).approvalIntentController.approvalEditMode, true)
    ;(app as any).inputLine.setValue(JSON.stringify({ file_path: '/a', content: 'edited' }))
    stdin.dataHandler!('\r')
    stdin.dataHandler!('y')
    assert.deepEqual(await a, { approved: true, editedInput: { file_path: '/a', content: 'edited' } })
    assert.equal((app as any).inputLine.value, 'draft')
    stdin.dataHandler!('n')
    assert.equal(await b, false)
  } finally { app.dispose() }
})

for (const ending of ['abort', 'error', 'final', 'dispose'] as const) {
  test(`${ending} settles all queued approvals and restores input`, async () => {
    const { app, stdin } = makeApp()
    try {
      app.setInput('draft')
      const results: unknown[] = []
      void app.callbacks.onApprovalRequired('a', 'write_file', {}).then(v => results.push(v))
      stdin.dataHandler!('e')
      void app.callbacks.onApprovalRequired('b', 'write_file', {}).then(v => results.push(v))
      if (ending === 'abort') app.callbacks.onAbort()
      if (ending === 'error') app.callbacks.onError(new Error('fixture'))
      if (ending === 'final') app.callbacks.onTurnComplete({}, 1, true)
      if (ending === 'dispose') app.dispose()
      await tick()
      assert.deepEqual(results, [false, false])
      assert.equal((app as any).approvalIntentController.approvalCount, 0)
      assert.equal((app as any).approvalIntentController.approvalEditMode, false)
      assert.equal((app as any).inputLine.value, 'draft')
      if (ending === 'abort') {
        const stale = wrapCallbacksWithTuiApp(app)
        app.callbacks.onAbort()
        assert.equal(await stale.onApprovalRequired('old', 'bash', {}), false)
      }
    } finally { app.dispose() }
  })
}
