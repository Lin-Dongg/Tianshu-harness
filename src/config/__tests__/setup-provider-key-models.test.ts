import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, saveConfig, setupProvider } from '../manager.js'
import { contractModels } from '../contract-models.js'
import { addProviderKey } from '../provider-key-store.js'
import { findModelOwner } from '../provider-keys.js'
import { readSecret } from '../secrets-store.js'

describe('setupProvider with key pools: reconnect selection and model sync', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-setup-keys-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    delete process.env.TEST_CUSTOM_KEY_ENV
    rmSync(dir, { recursive: true, force: true })
  })

  it('reconnect selection replaces default key models and syncs top-level snapshot', () => {
    // 1. Initial setup with pro-only model
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-init',
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    const initialProv = loadConfig().provider.providers.deepseek!
    assert.ok(initialProv.keys && initialProv.keys.length > 0, 'provider should have keys pool')
    assert.deepEqual(
      contractModels(initialProv).map(m => m.id),
      ['deepseek-v4-pro'],
    )

    // 2. Reconnect with new selection [flash, pro]
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-reconnect',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 },
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    const reloaded = loadConfig().provider.providers.deepseek!
    const effectiveModelIds = contractModels(reloaded).map(m => m.id)

    // Contract models (consumed by CLI /model) must reflect new selection
    assert.deepEqual(effectiveModelIds, ['deepseek-flash', 'deepseek-v4-pro'])

    // Top-level models snapshot must also stay synchronized
    assert.deepEqual(
      reloaded.models.map(m => m.id),
      ['deepseek-flash', 'deepseek-v4-pro'],
    )
  })

  it('metadata append (modelsMode: append) merges into default key and top-level models', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-append-init',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    setupProvider({
      providerName: 'deepseek',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
      modelsMode: 'append',
    })

    const prov = loadConfig().provider.providers.deepseek!
    const models = contractModels(prov)
    assert.equal(models.length, 2)
    const flash = models.find(m => m.id === 'deepseek-flash')!
    assert.equal(flash.contextWindow, 1_000_000)
    assert.equal(flash.maxTokens, 128_000)
    assert.ok(models.some(m => m.id === 'deepseek-v4-pro'))

    // Top-level snapshot matches default key
    assert.deepEqual(prov.models.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('preserves other key pools when setupProvider updates default key models', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-primary',
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    // Add a secondary key to the pool
    addProviderKey('deepseek', {
      label: 'secondary',
      apiKey: 'sk-secondary',
      models: [
        { id: 'deepseek-custom-secondary', contextWindow: 64_000, maxTokens: 4_096 },
      ],
    })

    // Reconnect primary/default key with new models
    setupProvider({
      providerName: 'deepseek',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    const prov = loadConfig().provider.providers.deepseek!
    assert.equal(prov.keys?.length, 2, 'both keys must be preserved')

    const defaultKey = prov.keys?.find(k => k.id === 'default') ?? prov.keys?.[0]
    const secondaryKey = prov.keys?.find(k => k.label === 'secondary')

    assert.deepEqual(defaultKey?.models.map(m => m.id), ['deepseek-flash'])
    assert.deepEqual(secondaryKey?.models.map(m => m.id), ['deepseek-custom-secondary'])

    // contractModels returns union of both keys
    const poolIds = contractModels(prov).map(m => m.id)
    assert.deepEqual(poolIds, ['deepseek-flash', 'deepseek-custom-secondary'])
  })

  it('synchronizes apiKey and apiKeyEnv to default key while preserving other keys', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-init-cred',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 }],
    })

    addProviderKey('deepseek', {
      label: 'secondary-env',
      apiKey: 'sk-secondary-keep',
      models: [{ id: 'secondary-model', contextWindow: 64_000, maxTokens: 4_096 }],
    })

    // Update with new inline apiKey
    setupProvider({
      providerName: 'deepseek',
      apiKey: 'sk-updated-cred',
    })

    let prov = loadConfig().provider.providers.deepseek!
    const defaultKey = prov.keys?.find(k => k.id === 'default') ?? prov.keys?.[0]
    const secondaryKey = prov.keys?.find(k => k.label === 'secondary-env')

    assert.equal(prov.keyRef, 'deepseek')
    assert.equal(defaultKey?.keyRef, 'deepseek')
    assert.equal(readSecret(defaultKey?.keyRef!), 'sk-updated-cred')
    assert.equal(readSecret(secondaryKey?.keyRef!), 'sk-secondary-keep')

    // Update with apiKeyEnv
    process.env.TEST_CUSTOM_KEY_ENV = 'sk-from-env'
    setupProvider({
      providerName: 'deepseek',
      apiKeyEnv: 'TEST_CUSTOM_KEY_ENV',
    })

    prov = loadConfig().provider.providers.deepseek!
    const defaultKeyEnv = prov.keys?.find(k => k.id === 'default') ?? prov.keys?.[0]
    assert.equal(prov.apiKeyEnv, 'TEST_CUSTOM_KEY_ENV')
    assert.equal(defaultKeyEnv?.apiKeyEnv, 'TEST_CUSTOM_KEY_ENV')
    assert.equal(defaultKeyEnv?.keyRef, undefined)

    // Secondary key remains untouched
    const secondaryKeyStill = prov.keys?.find(k => k.label === 'secondary-env')
    assert.equal(readSecret(secondaryKeyStill?.keyRef!), 'sk-secondary-keep')
  })

  // ── 2026-10-08 审查 P2 ③：单模型编辑不得劫持路由归属 ────────────────────
  // 此前 options.model 路径只在顶层克隆（= 默认池副本）里 findIndex，找不到即
  // unshift——只存在于次级 key 的模型被复制进默认 key，findModelOwner 按池序
  // 先中默认 key，此后该模型请求的凭据从次级 key 切到默认 key。
  it('editing a model owned by a secondary key stays on that key (no default-pool hijack)', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-primary',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 }],
    })
    const secondary = addProviderKey('deepseek', {
      label: 'secondary',
      apiKey: 'sk-secondary',
      models: [{ id: 'secondary-only', contextWindow: 64_000, maxTokens: 4_096, supportsVision: true }],
    })

    // 桌面 Settings 表单路径：编辑只存在于次级 key 的模型（表单只发四个字段）。
    setupProvider({
      providerName: 'deepseek',
      model: { id: 'secondary-only', contextWindow: 96_000, maxTokens: 8_192 },
    })

    const prov = loadConfig().provider.providers.deepseek!
    const defaultKey = prov.keys!.find(k => k.id === 'default') ?? prov.keys![0]!
    const secondaryKey = prov.keys!.find(k => k.id === secondary.id)!
    assert.ok(
      !defaultKey.models.some(m => m.id === 'secondary-only'),
      '编辑不得把次级 key 的模型复制进默认 key——那会把请求凭据切到默认 key',
    )
    const edited = secondaryKey.models.find(m => m.id === 'secondary-only')!
    assert.equal(edited.contextWindow, 96_000)
    assert.equal(edited.maxTokens, 8_192)
    assert.equal(edited.supportsVision, true, 'merge 语义保留表单未携带的字段')
    const owner = findModelOwner(prov, 'secondary-only')
    assert.equal(owner?.owner?.id, secondary.id, '路由归属必须仍是次级 key')
  })

  it('adding a brand-new model still lands on the default key, first position', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-primary',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 }],
    })
    const secondary = addProviderKey('deepseek', {
      label: 'secondary',
      apiKey: 'sk-secondary',
      models: [{ id: 'secondary-only', contextWindow: 64_000, maxTokens: 4_096 }],
    })

    setupProvider({
      providerName: 'deepseek',
      model: { id: 'brand-new', contextWindow: 128_000, maxTokens: 8_192 },
    })

    const prov = loadConfig().provider.providers.deepseek!
    const defaultKey = prov.keys!.find(k => k.id === 'default') ?? prov.keys![0]!
    assert.equal(defaultKey.models[0]!.id, 'brand-new', '新增模型落默认池首位（连接流程的位置性默认语义）')
    const secondaryKey = prov.keys!.find(k => k.id === secondary.id)!
    assert.ok(!secondaryKey.models.some(m => m.id === 'brand-new'))
  })

  // ── 2026-10-08 审查 P2 ④：applyProviderCredential 切换须回收孤儿 secret ──
  // 惯例（provider-key-store.updateProviderKeyCredential / manager.setApiKeyEnv）：
  // keyRef 切 apiKeyEnv 时，旧 secret 在全仓无引用方即回收。setupProvider 的
  // applyProviderCredential 通道此前不回收，旧 secret 永久滞留 secrets.json。
  it('switching the default key from keyRef to apiKeyEnv reclaims the orphaned secret', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-to-orphan',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 }],
    })
    assert.equal(readSecret('deepseek'), 'sk-to-orphan')

    process.env.TEST_CUSTOM_KEY_ENV = 'sk-from-env'
    setupProvider({ providerName: 'deepseek', apiKeyEnv: 'TEST_CUSTOM_KEY_ENV' })

    const prov = loadConfig().provider.providers.deepseek!
    assert.equal(prov.apiKeyEnv, 'TEST_CUSTOM_KEY_ENV')
    assert.equal(readSecret('deepseek'), undefined,
      'keyRef 切走后旧 secret 已无任何引用方——必须按惯例回收，不得滞留成孤儿')
  })

  it('keeps the secret when another key still references the same keyRef', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-shared',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 }],
    })
    const secondary = addProviderKey('deepseek', {
      label: 'secondary',
      apiKey: 'sk-secondary',
      models: [{ id: 'secondary-only', contextWindow: 64_000, maxTokens: 4_096 }],
    })
    // 手改配置共享 keyRef 的合法场景：次级 key 指向默认 key 的同一 secret。
    const cfg = loadConfig()
    cfg.provider.providers.deepseek!.keys!.find(k => k.id === secondary.id)!.keyRef = 'deepseek'
    saveConfig(cfg)

    process.env.TEST_CUSTOM_KEY_ENV = 'sk-from-env'
    setupProvider({ providerName: 'deepseek', apiKeyEnv: 'TEST_CUSTOM_KEY_ENV' })

    assert.equal(readSecret('deepseek'), 'sk-shared',
      '次级 key 仍引用同一 keyRef——共享引用保留，不得误删')
  })
})
