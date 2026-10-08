import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { cloneProviderPreset } from '../provider-presets.js'
import { contractModels } from '../contract-models.js'

/**
 * 退役迁移不得制造悬空引用（2026-10-06 开源仓 3.28 用户反馈回归族）。
 *
 * 背景：migrateDeepseekV4FlashRetirement 把 defaultModel/visionModel 等引用
 * 无条件改指 deepseek-flash，但池侧补救只有「池里恰有 v4-flash 条目时改名」。
 * 用户池子里既没有 v4-flash 也没有 flash（设置页剪枝 userSaved、或 keys 池
 * 形态下顶层快照不进契约池）时，引用指向池外模型 → 每次启动报
 * 「配置的模型 "deepseek-flash" 不在 provider "deepseek" 下」并位置性回退。
 *
 * 不变量：迁移后，被重定向的引用必须能在 contractModels（契约池）中解析。
 */
describe('退役迁移不制造悬空引用 — loadConfig 端到端', () => {
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-retire-dangling-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  /** 场景 A：用户在设置页把 deepseek 池剪到只剩 v4-pro（userSaved），defaultModel 还是旧默认 v4-flash。 */
  function writeUserPrunedPool(extra?: Record<string, unknown>): void {
    writeFileSync(configPath, JSON.stringify({
      ...extra,
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }],
          },
        },
      },
    }))
  }

  /** 场景 B：keys 池是事实源且只有 v4-pro；顶层快照（不进契约池）残留 v4-flash。 */
  function writeKeysPool(extra?: Record<string, unknown>): void {
    writeFileSync(configPath, JSON.stringify({
      ...extra,
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            models: [
              { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
              { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 },
            ],
            keys: [{
              id: 'default',
              models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }],
            }],
          },
        },
      },
    }))
  }

  /** 契约池可解析性断言：引用的模型 id 必须在 contractModels 结果中。 */
  function assertResolvable(cfg: ReturnType<typeof loadConfig>, ref: string | undefined, label: string): void {
    assert.ok(ref, `${label} 未设置`)
    const providerName = ref!.includes(':') ? ref!.slice(0, ref!.indexOf(':')) : 'deepseek'
    const modelId = ref!.includes(':') ? ref!.slice(ref!.indexOf(':') + 1) : ref!
    const provider = cfg.provider.providers[providerName]
    assert.ok(provider, `${label}: provider "${providerName}" 不存在`)
    const pool = contractModels(provider).map(m => m.id)
    assert.ok(
      pool.includes(modelId),
      `${label}: "${ref}" 指向池外模型（契约池 = [${pool.join(', ')}]）——启动必报「不在 provider 下」`,
    )
  }

  it('A(userSaved 剪枝): defaultModel 重定向后在契约池可解析', () => {
    writeUserPrunedPool({ agent: { defaultModel: 'deepseek:deepseek-v4-flash' } })
    const cfg = loadConfig()
    assertResolvable(cfg, cfg.agent.defaultModel, 'defaultModel')
  })

  it('A(userSaved 剪枝): visionModel 重定向后在契约池可解析', () => {
    writeUserPrunedPool({ agent: { visionModel: { provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', maxTokens: 1024 } } })
    const cfg = loadConfig()
    const vm = cfg.agent.visionModel
    assert.ok(vm)
    const pool = contractModels(cfg.provider.providers.deepseek!).map(m => m.id)
    assert.ok(pool.includes(vm!.model), `visionModel "${vm!.model}" 指向池外（契约池 = [${pool.join(', ')}]）`)
  })

  it('B(keys 池): defaultModel 重定向后在契约池可解析', () => {
    writeKeysPool({ agent: { defaultModel: 'deepseek:deepseek-v4-flash' } })
    const cfg = loadConfig()
    assertResolvable(cfg, cfg.agent.defaultModel, 'defaultModel')
  })

  it('B(keys 池): defaultModel 用短名 v4-flash 写的同样接住', () => {
    writeKeysPool({ agent: { defaultModel: 'deepseek:v4-flash' } })
    const cfg = loadConfig()
    assertResolvable(cfg, cfg.agent.defaultModel, 'defaultModel')
  })

  it('B(keys 池): 迁移后再次加载不改写磁盘（幂等）', () => {
    writeKeysPool({ agent: { defaultModel: 'deepseek:deepseek-v4-flash' } })
    loadConfig()
    const afterFirst = readFileSync(configPath, 'utf-8')
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8'), afterFirst, '第二次加载不得再改写磁盘')
  })

  it('C(对照，常规升级): 重定向后 defaultModel 指向 deepseek-flash 且在池中', () => {
    writeFileSync(configPath, JSON.stringify({
      agent: { defaultModel: 'deepseek:deepseek-v4-flash' },
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            models: [
              { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
              { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 },
              { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 256_000, supportsVision: true },
            ],
          },
        },
      },
    }))
    const cfg = loadConfig()
    assert.equal(cfg.agent.defaultModel, 'deepseek:deepseek-flash')
    assertResolvable(cfg, cfg.agent.defaultModel, 'defaultModel')
  })

  // ── 2026-10-08 补漏：3.28→3.29「已迁移」存量（缺口探针 A/C/D）──────────
  // 上面场景都从「引用还是旧 id」出发——重定向动作发生，顺带触发补池。
  // 已迁移用户引用早已 = deepseek-flash，升级后不再产生任何重定向动作，
  // 补池永不触发、悬空持续（每次启动告警 + 位置性回退）。守卫必须不依赖
  // 动作，无条件复查「被引用的 REPLACEMENT 在契约池可达」。

  it('D(已迁移存量, userSaved 剪枝): defaultModel 已是 flash 但池缺它——启动补池', () => {
    writeUserPrunedPool({ agent: { defaultModel: 'deepseek:deepseek-flash' } })
    const cfg = loadConfig()
    assertResolvable(cfg, cfg.agent.defaultModel, 'defaultModel')
  })

  it('D(已迁移存量, keys 池): 同上', () => {
    writeKeysPool({ agent: { defaultModel: 'deepseek:deepseek-flash' } })
    const cfg = loadConfig()
    assertResolvable(cfg, cfg.agent.defaultModel, 'defaultModel')
  })

  it('D(已迁移存量): 视觉引用指向 flash 时同样补池', () => {
    writeUserPrunedPool({ agent: { visionModel: { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 1024 } } })
    const cfg = loadConfig()
    const vm = cfg.agent.visionModel
    const pool = contractModels(cfg.provider.providers.deepseek!).map(m => m.id)
    assert.ok(vm && pool.includes(vm.model), `visionModel "${vm?.model}" 指向池外（契约池 = [${pool.join(', ')}]）`)
  })

  it('D(幂等): 补池落盘后二次加载不再改写', () => {
    writeUserPrunedPool({ agent: { defaultModel: 'deepseek:deepseek-flash' } })
    loadConfig()
    const afterFirst = readFileSync(configPath, 'utf-8')
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8'), afterFirst, '第二次加载不得再改写磁盘')
  })

  it('D(负例): 无引用指向 flash 时不得无差别回流（剪枝语义保留）', () => {
    writeUserPrunedPool({ agent: { defaultModel: 'deepseek:deepseek-v4-pro' } })
    loadConfig()
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8')) as { provider: { providers: { deepseek: { models: Array<{ id: string }> } } } }
    const ids = onDisk.provider.providers.deepseek.models.map(m => m.id)
    assert.ok(!ids.includes('deepseek-flash'), `未引用 flash 时不得把 flash 回流进池（实际池 = [${ids.join(', ')}]）`)
  })
})
