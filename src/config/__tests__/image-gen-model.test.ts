import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { getImageGenModelConfig, registerImageGenModelConfig, setImageGenModelConfig } from '../image-gen-model.js'

describe('image generation model config (issue #8)', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-image-gen-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined when no image-gen model is configured', () => {
    // fail-closed 的基线：未配置 = undefined，generate_image 据此不注册。
    assert.equal(getImageGenModelConfig(), undefined)
  })

  it('atomically registers a dedicated image-gen provider without touching the primary', () => {
    const before = loadConfig()
    const saved = registerImageGenModelConfig({
      providerName: 'imagegen-custom',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'black-forest-labs/FLUX.2-pro',
    })

    const after = loadConfig()
    // issue 的核心约束：primary 与 default model 逐字节不变（前缀缓存的锚）。
    assert.equal(after.provider.default, before.provider.default)
    assert.equal(after.agent.defaultModel, before.agent.defaultModel)
    assert.deepEqual(saved, { provider: 'imagegen-custom', model: 'black-forest-labs/FLUX.2-pro' })
    assert.deepEqual(after.agent.imageGenModel, saved)
    assert.deepEqual(getImageGenModelConfig(), saved)
  })

  // 方向反对称性（本方案与 vision 链路最大的差异点）：生图模型卡必须打
  // supportsImageGen，**绝不能**打 supportsVision——后者语义是"接受图片输入"
  // （图→文）。照抄 registerVisionModelConfig 的无条件 supportsVision:true 会把
  // 生图模型泄进 vision auto-bridge 候选池、模型选择器徽章与 settings-persist
  // 的覆盖逻辑。
  it('marks the model supportsImageGen and never supportsVision', () => {
    registerImageGenModelConfig({
      providerName: 'imagegen-mark',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    const card = loadConfig().provider.providers['imagegen-mark']?.models[0]
    assert.equal(card?.supportsImageGen, true)
    assert.equal(
      card?.supportsVision,
      undefined,
      '生图模型不是识图模型——打上 supportsVision 会污染 vision auto-bridge 候选与徽章',
    )
  })

  it('persists the sizeField wire-name override (SiliconFlow sends image_size)', () => {
    const saved = registerImageGenModelConfig({
      providerName: 'imagegen-size',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
      sizeField: 'image_size',
    })
    assert.equal(saved.sizeField, 'image_size')
    assert.equal(getImageGenModelConfig()?.sizeField, 'image_size')
  })

  it('omits sizeField when not supplied — absent means the OpenAI shape', () => {
    const saved = registerImageGenModelConfig({
      providerName: 'imagegen-default-size',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'gpt-image-1',
    })
    // 不留显式 undefined 键：zod 会把它保下来，调用方的结构比较会莫名失败。
    assert.equal('sizeField' in saved, false)
  })

  it('refuses to replace the default provider', () => {
    const before = JSON.stringify(loadConfig())
    const defaultProvider = loadConfig().provider.default
    assert.throws(() => registerImageGenModelConfig({
      providerName: defaultProvider,
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKey: 'sk-test',
      modelId: 'flux-pro',
    }), /cannot replace the default provider/)
    assert.equal(JSON.stringify(loadConfig()), before)
  })

  it('does not mutate config when validation fails', () => {
    const before = JSON.stringify(loadConfig())
    assert.throws(() => registerImageGenModelConfig({
      providerName: 'imagegen-invalid',
      baseUrl: 'not-a-url',
      modelId: 'flux-pro',
    }))
    assert.equal(JSON.stringify(loadConfig()), before)
  })

  it('rejects blank provider/model ids and key misuse', () => {
    assert.throws(() => registerImageGenModelConfig({
      providerName: '   ',
      baseUrl: 'https://api.siliconflow.com/v1',
      modelId: 'flux-pro',
    }))
    assert.throws(() => registerImageGenModelConfig({
      providerName: 'imagegen-blank',
      baseUrl: 'https://api.siliconflow.com/v1',
      modelId: '  ',
    }))
    // apiKey 与 apiKeyEnv 互斥——两者同给会让人分不清实际用的是哪个。
    assert.throws(() => registerImageGenModelConfig({
      providerName: 'imagegen-both-keys',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKey: 'sk-test',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    }))
  })

  it('is re-registrable for the same dedicated provider (idempotent happy path)', () => {
    const first = registerImageGenModelConfig({
      providerName: 'imagegen-re',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    const second = registerImageGenModelConfig({
      providerName: 'imagegen-re',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    assert.deepEqual(second, first)
  })

  // D2a：重注册/重选模型走的是「槽整体替换」——用户配好的 prompt/size/timeoutMs
  // 会在一次兼容重注册里被清空。同 provider 重注册必须把这些通用生成参数留下。
  it('preserves prompt/size/timeoutMs/sizeField across a compatible re-registration (D2a)', () => {
    registerImageGenModelConfig({
      providerName: 'imagegen-preserve',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    // 槽上附加生成参数（桌面端保存路径：只写槽，不碰 provider）。
    setImageGenModelConfig({
      provider: 'imagegen-preserve',
      model: 'flux-pro',
      prompt: 'a cinematic photo of',
      size: '1024x1024',
      timeoutMs: 60_000,
      sizeField: 'image_size',
    })
    const saved = registerImageGenModelConfig({
      providerName: 'imagegen-preserve',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    assert.equal(saved.prompt, 'a cinematic photo of', 'prompt 保留')
    assert.equal(saved.size, '1024x1024', 'size 保留')
    assert.equal(saved.timeoutMs, 60_000, 'timeoutMs 保留')
    assert.equal(saved.sizeField, 'image_size', '同 provider 重注册继承 sizeField')
    assert.deepEqual(getImageGenModelConfig(), saved, '落盘与返回值同为合并后的完整槽')
  })

  // sizeField 是线上 wire name，跟 provider 绑定：跨 provider 沿用旧值会发错字段名。
  it('does not inherit sizeField across providers on a fresh registration (D2a)', () => {
    registerImageGenModelConfig({
      providerName: 'imagegen-a',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
      sizeField: 'image_size',
    })
    const saved = registerImageGenModelConfig({
      providerName: 'imagegen-b',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'gpt-image-1',
    })
    assert.equal(saved.provider, 'imagegen-b')
    assert.equal('sizeField' in saved, false, '跨 provider 不继承旧 provider 的 sizeField wire name')
  })

  // ── setImageGenModelConfig：只写槽，provider 必须已存在 ────────────────────
  // 与 register 的分工：register 负责"注册一个专用 provider 并选它"（一次写入），
  // set 负责"从一个已存在的 provider 里选模型"（桌面端下拉框路径）。
  it('sets and clears the slot without touching the provider section', () => {
    registerImageGenModelConfig({
      providerName: 'imagegen-set',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    const before = JSON.stringify(loadConfig().provider)
    const saved = setImageGenModelConfig({ provider: 'imagegen-set', model: 'flux-pro', size: '1024x1024' })
    assert.equal(saved?.size, '1024x1024')
    assert.equal(JSON.stringify(loadConfig().provider), before, '只写槽时 provider 段逐字节不动')

    const cleared = setImageGenModelConfig(null)
    assert.equal(cleared, null)
    assert.equal(getImageGenModelConfig(), undefined)
  })

  it('treats an empty provider/model as a clear', () => {
    registerImageGenModelConfig({
      providerName: 'imagegen-clear',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    assert.equal(setImageGenModelConfig({ provider: '', model: 'flux-pro' }), null)
    assert.equal(loadConfig().agent.imageGenModel, undefined)
  })

  // 与 setVisionModelConfig 同源的历史坑：不校验存在性时，写盘成功而运行时静默
  // 失败，用户以为配了实际没生效。
  it('rejects a provider/model that is not configured', () => {
    assert.throws(
      () => setImageGenModelConfig({ provider: 'ghost-prov', model: 'ghost-model' }),
      /不在已配置的 provider 列表里/,
    )
    assert.equal(getImageGenModelConfig(), undefined)
  })

  it('rejects an unknown sizeField value instead of silently dropping it', () => {
    registerImageGenModelConfig({
      providerName: 'imagegen-sf',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_API_KEY',
      modelId: 'flux-pro',
    })
    assert.throws(() => setImageGenModelConfig({
      provider: 'imagegen-sf', model: 'flux-pro', sizeField: 'width',
    }))
  })
})
