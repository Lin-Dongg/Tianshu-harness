import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { cloneProviderPreset } from '../provider-presets.js'

/**
 * 官方 deepseek 供应商退役 deepseek-v4-flash（2026-10-04）。
 * 实际模型名是 deepseek-flash（版本 DeepSeek-V4.1-Flash）。
 * 中转 / 方舟上的同名 id 不动。
 */
describe('deepseek-v4-flash 官方退役 — loadConfig', () => {
  const RETIRED = 'deepseek-v4-flash'
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-v4-flash-retire-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('快照里只有旧 id 时改名为 deepseek-flash', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: RETIRED, contextWindow: 500_000, maxTokens: 32_000 }],
          },
        },
      },
    }))
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'deepseek-flash')
    assert.ok(model)
    assert.equal(loadConfig().provider.providers.deepseek!.models.some(m => m.id === RETIRED), false)
    assert.equal(model.contextWindow, 500_000, '用户调过的窗口保留')
    assert.equal(model.supportsVision, true, '改名后按正式视觉档回填')
  })

  it('两条都在时删掉旧 id，留下 deepseek-flash', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [
              { id: RETIRED, contextWindow: 1_000_000, maxTokens: 256_000 },
              { id: 'deepseek-flash', contextWindow: 200_000, maxTokens: 8_000, supportsVision: true },
            ],
          },
        },
      },
    }))
    const models = loadConfig().provider.providers.deepseek!.models
    assert.equal(models.filter(m => m.id === 'deepseek-flash').length, 1)
    assert.equal(models.find(m => m.id === 'deepseek-flash')!.contextWindow, 200_000)
    assert.equal(models.some(m => m.id === RETIRED), false)
  })

  it('defaultModel / 短名 / cheap-flash 档案改指 deepseek-flash', () => {
    writeFileSync(configPath, JSON.stringify({
      agent: { defaultModel: 'deepseek:v4-flash' },
      workers: { profiles: { 'cheap-flash': { provider: 'deepseek', model: RETIRED } } },
      provider: {
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 256_000, supportsVision: true }],
          },
        },
      },
    }))
    const cfg = loadConfig()
    assert.equal(cfg.agent.defaultModel, 'deepseek:deepseek-flash')
    assert.equal(cfg.workers.profiles['cheap-flash']?.model, 'deepseek-flash')
  })

  it('别的 provider 上的同名模型不动', () => {
    writeFileSync(configPath, JSON.stringify({
      workers: { profiles: { 'relay-flash': { provider: 'opencode-go', model: RETIRED } } },
      provider: {
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 256_000, supportsVision: true }],
          },
          'opencode-go': {
            ...cloneProviderPreset('opencode-go'),
            apiKey: 'sk-go',
            userSaved: true,
            models: [{ id: RETIRED, contextWindow: 1_000_000, maxTokens: 64_000 }],
          },
        },
      },
    }))
    const cfg = loadConfig()
    assert.ok(cfg.provider.providers['opencode-go']!.models.some(m => m.id === RETIRED))
    assert.equal(cfg.workers.profiles['relay-flash']?.model, RETIRED)
  })

  it('第二次加载不再改写磁盘', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: RETIRED, contextWindow: 1_000_000, maxTokens: 256_000 }],
          },
        },
      },
    }))
    loadConfig()
    const afterFirst = readFileSync(configPath, 'utf-8')
    assert.equal(afterFirst.includes(RETIRED), false)
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8'), afterFirst)
  })
})
