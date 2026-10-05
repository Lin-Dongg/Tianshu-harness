/**
 * PR-3 Wave 3：请求端按「模型归属哪个 key」解析凭据。
 *
 * 断言的落点是 resolveModelSpec 返回的 apiKey——那是最终冻结进 client 的值，
 * 也是「多 key 到底有没有生效」唯一可观察的结果。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyModelSpecMiss, listAllModels, resolveModelSpec, providerHasUsableAuth, type ServeContext } from '../serve.js'
import { loadConfig, setApiKey } from '../../config/manager.js'
import { writeSecret } from '../../config/secrets-store.js'
import type { Config } from '../../config/schema.js'

const RELAY = 'acme-relay'

describe('resolveModelSpec with a multi-key pool', () => {
  const prevHome = process.env.RIVET_HOME
  let home = ''

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-serve-multikey-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  /** 写盘 → loadConfig → 组一个最小 ServeContext（默认 provider 取 RELAY）。 */
  function load(providers: Record<string, unknown>, defaultName = RELAY): { config: Config; ctx: ServeContext } {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ provider: { default: defaultName, providers } }, null, 2) + '\n',
    )
    // A′ 后 keys 池的权威源是 provider-keys.json——重建 config.json 时必须一并清掉
    // keys 文件，否则上一个用例的池会跨用例存活（隔离假设随落盘形态更新）。
    rmSync(join(home, 'provider-keys.json'), { force: true })
    const config = loadConfig()
    const provider = config.provider.providers[defaultName]!
    return {
      config,
      ctx: { config, provider, model: provider.models[0] ?? { id: 'x', maxTokens: 1, contextWindow: 1 }, apiKey: '', auth: undefined, configured: true },
    }
  }

  const base = { name: RELAY, baseUrl: 'https://relay.example.com/v1', protocol: 'openai' }

  it('resolves each model through the credential of the key that owns it', () => {
    writeSecret('acme-relay:k_one', 'sk-key-one')
    writeSecret('acme-relay:k_two', 'sk-key-two')
    const { ctx } = load({
      [RELAY]: {
        ...base,
        keys: [
          { id: 'default', keyRef: 'acme-relay:k_one', models: [{ id: 'model-one' }] },
          { id: 'k_two', keyRef: 'acme-relay:k_two', models: [{ id: 'model-two' }] },
        ],
        models: [{ id: 'model-one' }],
      },
    })
    assert.equal(resolveModelSpec(ctx, 'model-one')!.apiKey, 'sk-key-one')
    assert.equal(resolveModelSpec(ctx, 'model-two')!.apiKey, 'sk-key-two')
    assert.equal(resolveModelSpec(ctx, `${RELAY}:model-two`)!.apiKey, 'sk-key-two')
  })

  it('keeps first-key-wins on a collided model id, and provider:keyId:modelId overrides it', () => {
    writeSecret('acme-relay:k_one', 'sk-key-one')
    writeSecret('acme-relay:k_two', 'sk-key-two')
    const { ctx } = load({
      [RELAY]: {
        ...base,
        keys: [
          { id: 'default', keyRef: 'acme-relay:k_one', models: [{ id: 'dup' }] },
          { id: 'k_two', keyRef: 'acme-relay:k_two', models: [{ id: 'dup' }] },
        ],
        models: [{ id: 'dup' }],
      },
    })
    assert.equal(resolveModelSpec(ctx, 'dup')!.apiKey, 'sk-key-one')
    assert.equal(resolveModelSpec(ctx, `${RELAY}:k_two:dup`)!.apiKey, 'sk-key-two')
  })

  it('falls back to the legacy top-level credential for an unmigrated provider', () => {
    writeSecret(RELAY, 'sk-legacy')
    const { ctx } = load({ [RELAY]: { ...base, keyRef: RELAY, models: [{ id: 'legacy-model' }] } })
    const spec = resolveModelSpec(ctx, 'legacy-model')
    assert.equal(spec!.apiKey, 'sk-legacy')
    // 迁移合成的 default key 与顶层槽同源——两条路径必须给同一个值。
    assert.equal(resolveModelSpec(ctx, `${RELAY}:default:legacy-model`)!.apiKey, 'sk-legacy')
  })

  it('still resolves a provider whose only credential lives on a non-default key', () => {
    writeSecret('acme-relay:k_two', 'sk-only-second')
    const { ctx } = load({
      [RELAY]: {
        ...base,
        keys: [
          { id: 'default', models: [{ id: 'model-one' }] },
          { id: 'k_two', keyRef: 'acme-relay:k_two', models: [{ id: 'model-two' }] },
        ],
        models: [{ id: 'model-one' }],
      },
    })
    assert.equal(resolveModelSpec(ctx, 'model-two')!.apiKey, 'sk-only-second')
    // 默认槽无凭据 → 该模型不可用（fail-closed，与既有「无 key 跳过」一致）。
    assert.equal(resolveModelSpec(ctx, 'model-one'), null)
    assert.equal(providerHasUsableAuth(RELAY, ctx.config.provider.providers[RELAY]!), true)
  })

  it('skips a provider with no resolvable credential and keeps scanning', () => {
    writeSecret('acme-relay:k_one', 'sk-real')
    const { ctx } = load({
      'no-key-relay': { name: 'no-key-relay', baseUrl: 'https://a.example.com/v1', protocol: 'openai', models: [{ id: 'shared-id' }] },
      [RELAY]: { ...base, keys: [{ id: 'default', keyRef: 'acme-relay:k_one', models: [{ id: 'shared-id' }] }], models: [{ id: 'shared-id' }] },
    })
    assert.equal(resolveModelSpec(ctx, 'shared-id')!.provider.name, RELAY)
    assert.equal(resolveModelSpec(ctx, 'shared-id')!.apiKey, 'sk-real')
  })

  it('lists models from every key in the picker enumeration', () => {
    writeSecret('acme-relay:k_one', 'sk-key-one')
    writeSecret('acme-relay:k_two', 'sk-key-two')
    const { ctx } = load({
      [RELAY]: {
        ...base,
        keys: [
          { id: 'default', keyRef: 'acme-relay:k_one', models: [{ id: 'model-one' }] },
          { id: 'k_two', keyRef: 'acme-relay:k_two', models: [{ id: 'model-two' }] },
        ],
        models: [{ id: 'model-one' }],
      },
    })
    const ids = listAllModels(ctx).filter(m => m.provider === RELAY).map(m => m.id)
    assert.deepEqual(ids, ['model-one', 'model-two'])
  })

  it('classifies a miss as key-missing when the model exists but its key has no credential', () => {
    const { config } = load({
      [RELAY]: {
        ...base,
        keys: [
          { id: 'default', models: [{ id: 'model-one' }] },
          { id: 'k_two', models: [{ id: 'model-two' }] },
        ],
        models: [{ id: 'model-one' }],
      },
    })
    assert.equal(classifyModelSpecMiss(config, 'model-two'), 'key-missing')
    assert.equal(classifyModelSpecMiss(config, `${RELAY}:k_two:model-two`), 'key-missing')
    assert.equal(classifyModelSpecMiss(config, `${RELAY}:k_two:nope`), 'unknown-model')
    assert.equal(classifyModelSpecMiss(config, 'nope'), 'unknown-model')
  })
})

describe('first-run flow: preset provider + a key set from the UI', () => {
  const prevHome = process.env.RIVET_HOME
  const prevEnv = process.env.DEEPSEEK_API_KEY
  let home = ''

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-firstrun-'))
    process.env.RIVET_HOME = home
    delete process.env.DEEPSEEK_API_KEY
    // 用户什么都没配：只有预设 provider（预设自带 apiKeyEnv + models）。
    writeFileSync(join(home, 'config.json'), JSON.stringify({ provider: { default: 'deepseek', providers: {} } }, null, 2) + '\n')
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevEnv === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevEnv
    rmSync(home, { recursive: true, force: true })
  })

  it('makes the key set from Settings actually take effect for model resolution', () => {
    // RED 判据：迁移若把预设继承的 apiKeyEnv 当成存量凭证合成 keys[0]，请求端就会
    // 读 keys[0].apiKeyEnv（env 没设 → 解析空），而用户刚写进 top-level keyRef 的
    // key 被静默忽略 —— resolveModelSpec 返回 null，模型切不了。
    const before = loadConfig().provider.providers.deepseek!
    assert.equal(before.keys, undefined, '未配凭证的预设 provider 不应被合成 keys')

    setApiKey('deepseek', 'sk-user-just-set')
    const cfg = loadConfig()
    const provider = cfg.provider.providers.deepseek!
    assert.equal(provider.keyRef, 'deepseek')

    // 用预设当前的模型 id，别再钉旧名：`deepseek-v4-flash` 已下线、由 V4.1 Flash
    // 承接（preset 的 id 会随版本演进），钉死旧名会周期性把「key 生效」这条断言拖红。
    const spec = resolveModelSpec(
      { config: cfg, provider, model: provider.models[0]!, apiKey: '', auth: undefined, configured: true },
      provider.models[0]!.id,
    )
    assert.ok(spec, '设置 key 后模型必须可解析')
    assert.equal(spec.apiKey, 'sk-user-just-set')
  })
})
