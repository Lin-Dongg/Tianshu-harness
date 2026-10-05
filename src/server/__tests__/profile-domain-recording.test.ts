import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { aggregateDomainUsage } from '../profile-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

test('manager persists actual usage once, suppresses recovery and survives restart', async () => {
  const persistence = new FileSessionPersistence(mkdtempSync(join(tmpdir(), 'profile-domain-')))
  const agent: ManagedAgent = {
    run: async (_prompt, callbacks: AgentCallbacks) => { callbacks.onDomainUsed?.('kaiyang'); callbacks.onDomainUsed?.('kaiyang') },
    abort: () => {}, listArtifacts: () => [], readArtifact: async () => null, getMessages: () => [],
    replaceMessages: () => {}, rewindToMessages: () => {},
  }
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: tmpdir(), persistence })
  const record = manager.createSession({ domain: 'auto' })
  assert.equal(manager.run(record.id, 'measure'), true)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(manager.run(record.id, 'recover', undefined, true), true)
  await new Promise(resolve => setTimeout(resolve, 30))
  persistence.flushSync()
  const restored = persistence.loadEvents(record.id)
  assert.equal(restored.filter(e => e.type === 'domain_usage').length, 1)
  assert.equal(aggregateDomainUsage([{ id: record.id, events: restored }], 30).domains[0]?.key, 'kaiyang')
})
