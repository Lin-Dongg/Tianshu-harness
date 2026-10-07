import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionTitleCoordinator, buildTitleCompletion, titleInput, fallbackTitle, loadTitleInput } from '../session-title.js'
import type { SessionRecord } from '../protocol.js'
import { providerSchema } from '../../config/schema.js'
import type { RuntimeParams } from '../../api/factory.js'
import type { AuthProvider } from '../../auth/types.js'

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id: 'session', cwd: '/tmp', status: 'idle', createdAt: 1, updatedAt: 1, lastSeq: 0, pendingApprovals: 0, ...overrides }
}
function fixture(complete: NonNullable<ConstructorParameters<typeof SessionTitleCoordinator>[0]['complete']>, overrides: Partial<SessionRecord> = {}, timeoutMs = 20) {
  const s = record(overrides)
  const saved: SessionRecord[] = []
  const coordinator = new SessionTitleCoordinator({ get: () => s, save: r => saved.push({ ...r }),
    models: () => ({ providers: {}, cheap: { provider: 'cheap', model: 'small' }, current: 'main:model' }), complete, timeoutMs,
  })
  return { s, coordinator, saved }
}

test('request failure and empty output both fall back to the current model', async () => {
  for (const cheap of [async () => { throw Error('unavailable') }, async () => '']) {
    const refs: string[] = []
    const { s, coordinator, saved } = fixture(ref => { refs.push(ref); return ref.startsWith('cheap:') ? cheap : async () => 'Fix sidebar' })
    const done = coordinator.generate(s.id, 'Please fix sidebar')
    assert.equal(s.title, 'Please fix sidebar')
    assert.equal(s.titleGenerationState, 'pending')
    await done
    assert.deepEqual(refs, ['cheap:small', 'main:model'])
    assert.equal(s.title, 'Fix sidebar')
    assert.equal(s.titleSource, 'generated')
    assert.equal(saved.at(-1)?.titleGenerationState, 'complete')
  }
})

test('only the current model is sufficient when the cheap client cannot be built', async () => {
  const { s, coordinator } = fixture(ref => ref.startsWith('cheap:') ? null : async () => 'Main model title')
  await coordinator.generate(s.id, 'Input')
  assert.equal(s.title, 'Main model title')
})

test('inflight requests deduplicate, timeout aborts and falls back', async () => {
  let aborted = false, calls = 0
  const { s, coordinator } = fixture(ref => {
    calls++
    return ref.startsWith('cheap:') ? (_sys, _user, signal) => new Promise(() => signal?.addEventListener('abort', () => { aborted = true })) : async () => 'Fallback'
  })
  const first = coordinator.generate(s.id, 'Input')
  assert.equal(coordinator.generate(s.id, 'Input'), first)
  await first
  assert.equal(aborted, true)
  assert.equal(calls, 2)
  assert.equal(s.title, 'Fallback')
})

test('two automatic attempts survive restart; explicit retry remains available', async () => {
  const { s, coordinator } = fixture(() => async () => '')
  await coordinator.generate(s.id, 'Input')
  await coordinator.generate(s.id, 'Input')
  await coordinator.generate(s.id, 'Input')
  assert.equal(s.titleGenerationAttempts, 2)
  const restored = new SessionTitleCoordinator({ get: () => s, save: () => {}, models: () => ({ providers: {}, current: 'main:model' }), complete: () => async () => 'Restored' })
  await restored.generate(s.id, 'Input')
  assert.equal(s.title, 'Input')
  await restored.generate(s.id, 'Input', true)
  assert.equal(s.title, 'Restored')
})

test('manual, legacy and archived titles are protected, including a rename during generation', async () => {
  for (const over of [{ title: 'Legacy' }, { title: 'Manual', titleSource: 'manual' as const }, { archived: true }]) {
    const { s, coordinator } = fixture(() => { assert.fail('must not call model') }, over)
    await coordinator.generate(s.id, 'Input')
    assert.equal(s.title, over.title)
  }
  let finish!: (value: string) => void
  const { s, coordinator } = fixture(() => () => new Promise(resolve => { finish = resolve }))
  const pending = coordinator.generate(s.id, 'Input')
  s.title = 'User chose this'; s.titleSource = 'manual'
  finish('Model title')
  await pending
  assert.equal(s.title, 'User chose this')
})

test('empty conversations do not request a title; attachment-only titles use names', async () => {
  const { s, coordinator } = fixture(() => { assert.fail('empty input') })
  await coordinator.generate(s.id, '')
  assert.equal(s.titleGenerationAttempts, undefined)
  assert.equal(titleInput('', ['report.pdf']), 'report.pdf')
  assert.equal(titleInput('Human request', ['report.pdf']), 'Human request')
  assert.equal(fallbackTitle('  Fix\n  sidebar  '), 'Fix sidebar')
  assert.equal(titleInput('x'.repeat(1000)).length, 800)
  assert.equal(await loadTitleInput(s, [{ seq: 1, ts: 1, type: 'user', data: { promptText: '', text: 'expanded archive', archives: [{ name: 'sources.zip' }] } }]), 'sources.zip')
  assert.equal(await loadTitleInput(s, [{ seq: 1, ts: 1, type: 'user', data: { promptText: '', images: ['image-data'] } }]), 'Image')
})

test('keyless and OAuth candidates build independent clients without API keys', () => {
  const oauth: AuthProvider = { isAuthenticated: () => true, getHeaders: async () => ({}), authenticate: async () => {}, dispose: () => {} }
  for (const provider of [
    providerSchema.parse({ name: 'ollama', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'local', alias: 'local' }] }),
    providerSchema.parse({ name: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', auth: { type: 'oauth', provider: 'codex' }, models: [{ id: 'local', alias: 'local' }] }),
  ]) {
    let captured: RuntimeParams | undefined
    const complete = buildTitleCompletion(`${provider.name}:local`, { [provider.name]: provider }, 'session', {
      createAuth: () => oauth,
      createClient: (_provider, _caps, params) => { captured = params; return { stream: async () => {} } as never },
    })
    assert.ok(complete)
    assert.equal(captured?.apiKey, '')
    assert.equal(captured?.sessionId, 'session')
    assert.equal(captured?.reasoningEffort, 'off')
    assert.equal(captured?.auth, provider.name === 'codex' ? oauth : undefined)
  }
})
