import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTransport, StdioConnectError } from '../transport-factory.js'
import { McpManager } from '../manager.js'

test('failed stdio handshake retains stderr, including a single chunk larger than the tail limit', async () => {
  await assert.rejects(createTransport({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("x".repeat(5000) + "npm error E404 package missing", () => process.exit(1))'],
  }, { timeoutMs: 5000 }), (err: unknown) => {
    assert.ok(err instanceof StdioConnectError)
    assert.match(err.message, /Connection closed/)
    assert.match(err.stderrTail, /npm error E404 package missing$/)
    assert.ok(err.stderrTail.length <= 4096)
    assert.ok(err.cause instanceof Error)
    return true
  })
})

test('manager classifies actual startup stderr and exposes it in connection status and logs', async () => {
  const mgr = new McpManager({ enabled: true, timeoutMs: 5000, servers: {} })
  try {
    const tools = await mgr.connectAndDiscover('startup-failure', {
      command: process.execPath,
      args: ['-e', 'process.stderr.write("npm error spawn cmd ENOENT", () => process.exit(1))'],
    })
    assert.deepEqual(tools, [])
    const state = mgr.getStates().find(s => s.serverId === 'startup-failure')
    assert.equal(state?.status, 'error')
    assert.equal(state?.lastErrorClass, 'process_env')
    assert.match(state?.error ?? '', /stderr: npm error spawn cmd ENOENT/)
    assert.match(mgr.getLogs('startup-failure').map(e => e.text).join('\n'), /spawn cmd ENOENT/)
  } finally { await mgr.shutdown() }
})
