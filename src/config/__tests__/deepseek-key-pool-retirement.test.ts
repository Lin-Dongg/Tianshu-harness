import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { cloneProviderPreset } from '../provider-presets.js'
import { assertDefaultModelRef, contractModels } from '../contract-models.js'
import { providerKeysPath, writeProviderKeysFile } from '../provider-keys-store.js'
import type { ModelConfig } from '../schema.js'

describe('DeepSeek retirement in the authoritative key pool', () => {
  let dir = ''
  let previousConfigPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-deepseek-key-retirement-'))
    previousConfigPath = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify({
      provider: { providers: { deepseek: { ...cloneProviderPreset('deepseek'), userSaved: true } } },
    }))
  })

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previousConfigPath
    rmSync(dir, { recursive: true, force: true })
  })

  it('repairs external pools before CLI enumeration and persists the repair', () => {
    writeProviderKeysFile({ version: 1, providers: {
      deepseek: [
        { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
        { id: 'flash', label: 'Flash key', models: [{ id: 'deepseek-v4-flash', contextWindow: 500_000, maxTokens: 32_000 }] },
      ],
      relay: [{ id: 'default', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, maxTokens: 8_000 }] }],
    } })

    const providers = loadConfig().provider.providers
    const flash = contractModels(providers.deepseek!).find(m => m.id === 'deepseek-flash')
    assert.ok(flash, 'the selector must see the current model from the external key pool')
    assert.equal(contractModels(providers.deepseek!).some(m => m.id === 'deepseek-v4-flash'), false)
    assert.equal(flash.contextWindow, 500_000)
    assert.equal(flash.maxTokens, 32_000)
    assert.equal(flash.supportsVision, true, 'injected model cards need preset capability backfill')
    assert.ok(flash.pricing)
    assert.equal(providers.deepseek!.keys![1]!.label, 'Flash key')
    assert.equal(contractModels(providers.relay!)[0]!.id, 'deepseek-v4-flash', 'gateway model names remain unchanged')

    const repairedFile = readFileSync(providerKeysPath(), 'utf8')
    loadConfig()
    assert.equal(readFileSync(providerKeysPath(), 'utf8'), repairedFile, 'the migration is idempotent')
    assert.equal(JSON.parse(repairedFile).providers.deepseek[1].models[0].id, 'deepseek-flash')
  })

  it('redirects a key whose only model is the retired vision experiment', () => {
    writeProviderKeysFile({ version: 1, providers: { deepseek: [{
      id: 'default',
      models: [{ id: 'deepseek-v4-flash-vision-exp', contextWindow: 400_000, maxTokens: 16_000 }],
    }] } })
    const models = contractModels(loadConfig().provider.providers.deepseek!)
    assert.deepEqual(models.map(m => m.id), ['deepseek-flash'])
    assert.equal(models[0]!.contextWindow, 400_000)
    assert.equal(models[0]!.supportsVision, true)
  })

  it('keeps an existing current model instead of duplicating retired aliases', () => {
    writeProviderKeysFile({ version: 1, providers: { deepseek: [{ id: 'default', models: [
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 256_000 },
      { id: 'deepseek-v4-flash-vision-exp', contextWindow: 1_000_000, maxTokens: 256_000 },
      { id: 'deepseek-flash', contextWindow: 200_000, maxTokens: 8_000, supportsVision: false },
    ] }] } })
    const models = contractModels(loadConfig().provider.providers.deepseek!)
    assert.deepEqual(models.map(m => m.id), ['deepseek-flash'])
    assert.equal(models[0]!.contextWindow, 200_000)
    assert.equal(models[0]!.supportsVision, false, 'explicit user capability overrides survive backfill')
  })

  // ── 2026-10-08 补错池修复：外部池形态下的悬空硬引用守卫 ────────────────
  // 审查实证：外部池=[v4-pro] + agent.defaultModel='deepseek:deepseek-flash' 时，
  // 注入前的守卫只能修 config.json 顶层快照（contractModels 有 keys 时不读它），
  // 注入后的重跑又没拿到 agent（守卫无引用可查）——provider-keys.json 纹丝不动，
  // 悬空持续（每次启动告警 + 位置性回退，Flash 价位静默变 Pro 价位）。
  // 守卫必须以 contractModels 实际读取的池（外部 key 池）为准做修补。
  describe('dangling hard refs repair the external pool', () => {
    function writeConfig(agent: Record<string, unknown>): void {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent,
        provider: { providers: { deepseek: { ...cloneProviderPreset('deepseek'), userSaved: true } } },
      }))
    }

    function writeProOnlyPool(models?: ModelConfig[]): void {
      writeProviderKeysFile({ version: 1, providers: { deepseek: [
        { id: 'default', models: models ?? [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
      ] } })
    }

    function persistedPoolIds(): string[] {
      const file = JSON.parse(readFileSync(providerKeysPath(), 'utf8')) as {
        providers: { deepseek: Array<{ models: Array<{ id: string }> }> }
      }
      return file.providers.deepseek.flatMap(k => k.models.map(m => m.id))
    }

    it('defaultModel → flash、外部池只有 v4-pro：flash 补进 key 池并落盘（幂等）', () => {
      writeConfig({ defaultModel: 'deepseek:deepseek-flash' })
      writeProOnlyPool()

      const cfg = loadConfig()
      const pool = contractModels(cfg.provider.providers.deepseek!).map(m => m.id)
      assert.ok(pool.includes('deepseek-flash'),
        `契约池必须含补回的 flash——否则 defaultModel 悬空（实际池 = [${pool.join(', ')}]）`)
      assert.ok(persistedPoolIds().includes('deepseek-flash'),
        '补回必须落进 provider-keys.json（事实源池），而不是无人读的 config.json 顶层快照')

      const afterFirst = readFileSync(providerKeysPath(), 'utf8')
      loadConfig()
      assert.equal(readFileSync(providerKeysPath(), 'utf8'), afterFirst, '第二次加载不得再改写 keys 文件')
    })

    it('visionModel → flash、外部池只有 v4-pro：同样补池', () => {
      writeConfig({ visionModel: { provider: 'deepseek', model: 'deepseek-flash' } })
      writeProOnlyPool()
      const pool = contractModels(loadConfig().provider.providers.deepseek!).map(m => m.id)
      assert.ok(pool.includes('deepseek-flash'), `visionModel 悬空（实际池 = [${pool.join(', ')}]）`)
    })

    it('key 池删到空（removeProviderKeyModel 允许）：补进第一个 key 而不是顶层', () => {
      writeConfig({ defaultModel: 'deepseek:deepseek-flash' })
      writeProOnlyPool([])
      const pool = contractModels(loadConfig().provider.providers.deepseek!).map(m => m.id)
      assert.deepEqual(pool, ['deepseek-flash'],
        '契约层对「有 keys 但并集为空」不回退顶层——补顶层等于没补')
      assert.deepEqual(persistedPoolIds(), ['deepseek-flash'])
    })

    it('负例：无引用指向 flash 时剪枝语义保留（不无差别回流）', () => {
      writeConfig({ defaultModel: 'deepseek:deepseek-v4-pro' })
      writeProOnlyPool()
      const pool = contractModels(loadConfig().provider.providers.deepseek!).map(m => m.id)
      assert.ok(!pool.includes('deepseek-flash'), `未引用 flash 时不得回流（实际池 = [${pool.join(', ')}]）`)
      assert.ok(!persistedPoolIds().includes('deepseek-flash'))
    })
  })

  // ── 2026-10-08 审查 P2：keyId 三段引用补池落点 + 裸引用判据收窄 ──────────
  // ① `deepseek:<keyId>:deepseek-flash` 形态下 assertDefaultModelRef 的 keyId 分支
  //   只认**该 key** 的池——守卫此前按末段判指向、补「首个含模型的 key 池」，补错
  //   key 引用仍悬空。修复：补池落点与被引用 key 对齐。
  // ② 裸 id（无 provider 前缀）按 parseModelRef 语义是全 provider 扫描——自建
  //   provider 持有同名模型时引用并不悬空，守卫此前仍把官方 preset 回流进
  //   deepseek 池。修复：有他方承接证据时不判指向。
  describe('keyId-pinned and bare hard refs', () => {
    function writeConfig(agent: Record<string, unknown>, extraProviders?: Record<string, unknown>): void {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent,
        provider: { providers: {
          deepseek: { ...cloneProviderPreset('deepseek'), userSaved: true },
          ...extraProviders,
        } },
      }))
    }

    function persistedKeyPools(): Array<{ id: string; models: string[] }> {
      const file = JSON.parse(readFileSync(providerKeysPath(), 'utf8')) as {
        providers: { deepseek: Array<{ id: string; models: Array<{ id: string }> }> }
      }
      return file.providers.deepseek.map(k => ({ id: k.id, models: k.models.map(m => m.id) }))
    }

    it('① 三段引用（外部池）：补进被引用 key 的池而不是首个含模型的池（幂等落盘）', () => {
      writeConfig({ defaultModel: 'deepseek:flash-key:deepseek-flash' })
      writeProviderKeysFile({ version: 1, providers: { deepseek: [
        { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
        { id: 'flash-key', models: [] },
      ] } })

      const cfg = loadConfig()
      const keys = cfg.provider.providers.deepseek!.keys!
      assert.ok(
        keys.find(k => k.id === 'flash-key')!.models.some(m => m.id === 'deepseek-flash'),
        'keyId 分支只认被引用 key 的池——flash 必须补进 flash-key',
      )
      assert.ok(
        !keys.find(k => k.id === 'default')!.models.some(m => m.id === 'deepseek-flash'),
        '不得落进首个含模型的池——那是两段引用的并集语义，三段引用仍悬空',
      )
      assert.doesNotThrow(() =>
        assertDefaultModelRef(cfg.provider.providers, 'deepseek:flash-key:deepseek-flash'))

      const persisted = persistedKeyPools()
      assert.ok(persisted.find(k => k.id === 'flash-key')!.models.includes('deepseek-flash'),
        '补回必须落进 provider-keys.json 的被引用 key')
      const afterFirst = readFileSync(providerKeysPath(), 'utf8')
      loadConfig()
      assert.equal(readFileSync(providerKeysPath(), 'utf8'), afterFirst, '第二次加载不得再改写 keys 文件')
    })

    it('① 三段引用重定向（config.json 内联池）：deepseek:k2:deepseek-v4-flash → flash 补进 k2', () => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent: { defaultModel: 'deepseek:k2:deepseek-v4-flash' },
        provider: { providers: { deepseek: {
          ...cloneProviderPreset('deepseek'),
          userSaved: true,
          models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }],
          keys: [
            { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
            { id: 'k2', models: [] },
          ],
        } } },
      }))

      const cfg = loadConfig()
      assert.equal(cfg.agent.defaultModel, 'deepseek:k2:deepseek-flash')
      const keys = cfg.provider.providers.deepseek!.keys!
      assert.ok(keys.find(k => k.id === 'k2')!.models.some(m => m.id === 'deepseek-flash'),
        '重定向后的三段引用必须在 k2 的池可解析')
      assert.ok(!keys.find(k => k.id === 'default')!.models.some(m => m.id === 'deepseek-flash'))
      assert.doesNotThrow(() => assertDefaultModelRef(cfg.provider.providers, 'deepseek:k2:deepseek-flash'))
    })

    it('① 负例：三段引用的 key 已不存在——不补（key 层级悬空补池救不了，不伪造回流）', () => {
      writeConfig({ defaultModel: 'deepseek:ghost:deepseek-flash' })
      writeProviderKeysFile({ version: 1, providers: { deepseek: [
        { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
      ] } })
      const pool = contractModels(loadConfig().provider.providers.deepseek!).map(m => m.id)
      assert.ok(!pool.includes('deepseek-flash'),
        `中间段不是现存 key id 时整段是模型 id（≠ 本档），不得据此回流（实际池 = [${pool.join(', ')}]）`)
      assert.ok(!persistedKeyPools().some(k => k.models.includes('deepseek-flash')))
    })

    it('② 裸引用且无他方承接：deepseek 池缺 flash 时补池（悬空守卫对裸 id 仍生效）', () => {
      writeConfig({ defaultModel: 'deepseek-flash' })
      writeProviderKeysFile({ version: 1, providers: { deepseek: [
        { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
      ] } })
      const pool = contractModels(loadConfig().provider.providers.deepseek!).map(m => m.id)
      assert.ok(pool.includes('deepseek-flash'),
        `裸 id 全 provider 扫描也找不到 flash = 悬空——必须补（实际池 = [${pool.join(', ')}]）`)
    })

    it('② 负例：裸引用由自建 provider 的同名模型承接——不得把官方 preset 回流进 deepseek 池', () => {
      writeConfig(
        { defaultModel: 'deepseek-flash' },
        { relay: {
          name: 'relay',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-relay',
          models: [{ id: 'deepseek-flash', contextWindow: 128_000, maxTokens: 8_000 }],
        } },
      )
      writeProviderKeysFile({ version: 1, providers: { deepseek: [
        { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
      ] } })
      const cfg = loadConfig()
      const pool = contractModels(cfg.provider.providers.deepseek!).map(m => m.id)
      assert.ok(!pool.includes('deepseek-flash'),
        `裸引用由 relay 的同名模型承接、并不悬空——补进 deepseek 池即无差别回流（实际池 = [${pool.join(', ')}]）`)
      assert.ok(!persistedKeyPools().some(k => k.models.includes('deepseek-flash')))
      assert.ok(contractModels(cfg.provider.providers.relay!).some(m => m.id === 'deepseek-flash'),
        '承接方 relay 的模型不得被动')
    })
  })
})
