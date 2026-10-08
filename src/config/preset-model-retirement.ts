/**
 * preset 模型退役 —— 存量配置的加载期清理。
 *
 * 与 preset-model-backfill.ts 同属「preset 与磁盘快照会漂移」这一族问题：config.json
 * 存的是应用预设那一刻的模型快照，而 deepMerge 对数组整组替换，所以**单改 preset
 * 到不了任何已装过的用户**。backfill 那半解决「字段缺失」，这里解决「条目该走了」。
 *
 * 每个退役都应当是一个独立的一次性迁移：preset 删条目只影响新装，存量用户靠这里。
 */

import { findPresetModel } from './provider-presets.js'
import type { ModelConfig } from './schema.js'

/** A vendor preset may be repointed to a gateway with its own valid model IDs. */
function isOfficialDeepseek(provider: Record<string, unknown> | undefined): boolean {
  if (!provider || provider.baseUrl === undefined) return true // Inherits the official default.
  if (typeof provider.baseUrl !== 'string') return false
  try { return new URL(provider.baseUrl).hostname === 'api.deepseek.com' }
  catch { return false }
}

/** 把退役条目在**顶层快照**与**每个权威 key 池**（`keys[].models`）里一并处理——
 *  选择器与请求端读的是后者，只改顶层等于没改（2026-10-08 收编公开仓 PR #381）。
 *  语义：池里已有替代档 → 删掉退役条目；没有 → 就地改名（保留用户调过的窗口与字段）。
 *  Returns true if any value was changed. */
function retireProviderModel(
  prov: Record<string, unknown> | undefined,
  retiredId: string,
  replacementId: string,
): boolean {
  if (!prov) return false
  let changed = false
  const rewrite = (target: Record<string, unknown>): void => {
    if (!Array.isArray(target.models)) return
    let hasReplacement = target.models.some(m =>
      !!m && typeof m === 'object' && (m as { id?: unknown }).id === replacementId,
    )
    let local = false
    const models: unknown[] = []
    for (const item of target.models) {
      if (!item || typeof item !== 'object' || (item as { id?: unknown }).id !== retiredId) {
        models.push(item)
        continue
      }
      local = true
      if (hasReplacement) continue
      models.push({ ...item, id: replacementId })
      hasReplacement = true
    }
    if (local) {
      target.models = models
      changed = true
    }
  }
  rewrite(prov)
  if (Array.isArray(prov.keys)) {
    for (const key of prov.keys) {
      if (key && typeof key === 'object') rewrite(key as Record<string, unknown>)
    }
  }
  return changed
}

/**
 * 重定向前保证 REPLACEMENT 在契约池中可达（2026-10-06，开源仓 3.28 用户反馈族）。
 *
 * 退役迁移把 defaultModel / visionModel / worker / review 等引用改指 REPLACEMENT，
 * 但池侧补救只有「池里恰有旧 id 条目时改名」一种——用户池子里既没有旧 id 也没有
 * REPLACEMENT（设置页剪枝 userSaved、或 keys 池形态下顶层快照不进契约池）时，
 * 引用指向池外模型：每次启动报「配置的模型 X 不在 provider 下」并位置性回退
 * models[0]（实测：剪到只剩 v4-pro 的池，回退档 v4-pro，Flash 价位静默变 Pro 价位）。
 *
 * 不变量：**迁移不得制造悬空引用**。这里把 REPLACEMENT 的 preset 条目补进
 * 事实源池——keys 池存在时补首个含模型的 key 池（契约层只认 keys 并集），否则
 * 补顶层 models。不做无差别回流（userSaved 的剪枝语义仍由 backfill 尊重），
 * 只在确有引用需要重定向时补——调用方在 redirect 之前调用，幂等由池内查重守卫。
 *
 * `targetKeyId`：引用是 `provider:keyId:model` 三段式时，补池落点必须与**被引用
 * 的 key** 对齐——契约层 keyId 分支（assertDefaultModelRef）只认该 key 的池，
 * 并集可达不算数；补进「首个含模型的 key」会让三段引用继续悬空。key 已不存在
 * 时引用在 key 层级悬空、补池救不了，落回并集逻辑兜底（两段引用仍受益；不伪造
 * key——伪造的空凭据 key 比悬空引用更难排查）。
 *
 * Mutates `raw` in place. Returns true if any value was changed.
 */
function ensureReplacementInPool(
  raw: Record<string, unknown>,
  providerName: string,
  replacementId: string,
  targetKeyId?: string,
): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const prov = providers?.[providerName] as Record<string, unknown> | undefined
  if (!prov) return false

  const hasId = (models: unknown): boolean =>
    Array.isArray(models) && models.some(m =>
      !!m && typeof m === 'object' && (m as { id?: unknown }).id === replacementId)

  const preset = findPresetModel(providerName, replacementId)
  if (!preset) return false // 查不到 preset 条目时无源可补——返回 true 会让每次加载都做无用写盘
  const appendPresetEntry = (models: unknown[]): void => {
    models.push({
      id: preset.id,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      ...(preset.supportsVision ? { supportsVision: true } : {}),
      ...(preset.supportsImageGen ? { supportsImageGen: true } : {}),
      ...(preset.tier ? { tier: preset.tier } : {}),
      ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
      pricing: { ...preset.pricing },
    } satisfies Partial<ModelConfig> & { id: string })
  }

  // 事实源池：keys 池存在时契约层只认 keys 并集（contractModels 不回退顶层——
  // 本函数此前注释声称「keys 全空会回退顶层」与实现相反，写顶层等于没补，2026-10-08
  // 审查实证）；没有任何 key 时顶层 models 才是契约池，才轮到补顶层。
  const keys = prov.keys
  if (Array.isArray(keys) && keys.length > 0) {
    // 三段引用钉了 keyId：补进被引用 key 的池（契约层 keyId 分支只认它）。
    if (targetKeyId !== undefined) {
      const pinned = keys.find(k =>
        !!k && typeof k === 'object' && (k as { id?: unknown }).id === targetKeyId,
      ) as Record<string, unknown> | undefined
      if (pinned) {
        if (hasId(pinned.models)) return false
        if (!Array.isArray(pinned.models)) pinned.models = []
        appendPresetEntry(pinned.models as unknown[])
        return true
      }
    }
    // 任一 key 已有替代档 → 并集可达，无需补（只看首个非空 key 会漏掉后续 key
    // 已持档的情况，补出并集重复条目）。
    for (const key of keys) {
      if (!key || typeof key !== 'object') continue
      if (hasId((key as Record<string, unknown>).models)) return false
    }
    // 补首个含模型的 key 池；全是空池（removeProviderKeyModel 允许删到空）时补
    // 第一个 key——空并集同样不回退顶层。
    let firstKey: Record<string, unknown> | undefined
    let target: Record<string, unknown> | undefined
    for (const key of keys) {
      if (!key || typeof key !== 'object') continue
      const slot = key as Record<string, unknown>
      if (!firstKey) firstKey = slot
      if (Array.isArray(slot.models) && slot.models.length > 0) { target = slot; break }
    }
    target ??= firstKey
    if (!target) return false // keys 全不是对象——畸形输入，不猜
    if (!Array.isArray(target.models)) target.models = []
    appendPresetEntry(target.models as unknown[])
    return true
  }
  const models = prov.models
  if (Array.isArray(models)) {
    if (hasId(models)) return false
    appendPresetEntry(models as unknown[])
    return true
  }
  return false
}

/**
 * One-shot migration: 退役 deepseek-v4-flash-vision-exp（2026-09-12 决策；官方文档：
 * 旧名仍可调用，但请求由最新的 Flash 承接，即该档已下线）。preset 已删条目，而存量
 * 用户的 models 快照里仍留着它。
 *
 * 比 v4-pro 退役多一层必要性：该档声明了 supportsVision，只要它排在存量快照视觉档的
 * 首位，**同 provider 自动识图桥就会选中它**。实测（2026-09-12 探针，真实 config）：
 *   detail = "自动选用 deepseek/deepseek-v4-flash-vision-exp"
 * 退役后自动桥自然落到 deepseek-flash（当前正式视觉档）。
 *
 * 同时重定向两个引用：agent.visionModel 指向它时改指正式视觉档——不重定向的话桥会在
 * 启动时报「provider 下没有模型」，图片照旧丢；agent.defaultModel 同理，否则会静默
 * 回退 models[0]（本轮已在 bootstrap/main 两处补了该回退的告警，但仍应避免发生）。
 *
 * 边界：只动 deepseek provider 下 id 完全等于该型号的条目——用户在别的 provider 下
 * 自建的同名模型（第三方中转）不受影响；只剩退役档时改名，保留用户调过的窗口。
 * 幂等：删干净、改到位之后返回 false。Mutates `raw` in place.
 * Returns true if any value was changed.
 */
export function migrateDeepseekVisionExpRetirement(raw: Record<string, unknown>): boolean {
  const RETIRED = 'deepseek-v4-flash-vision-exp'
  const RETIRED_ALIAS = 'v4-vision'
  const REPLACEMENT = 'deepseek-flash'
  let changed = false

  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const ds = providers?.['deepseek'] as Record<string, unknown> | undefined
  if (!isOfficialDeepseek(ds)) return false
  if (retireProviderModel(ds, RETIRED, REPLACEMENT)) changed = true

  const agent = raw.agent as Record<string, unknown> | undefined
  if (agent) {
    // 识图桥指向退役档 → 改指正式视觉档（不重定向 = 桥起不来 + 图片照旧丢）
    const vm = agent.visionModel as Record<string, unknown> | undefined
    if (vm && vm['provider'] === 'deepseek' && (vm['model'] === RETIRED || vm['model'] === RETIRED_ALIAS)) {
      if (ensureReplacementInPool(raw, 'deepseek', REPLACEMENT)) changed = true
      agent.visionModel = { ...vm, model: REPLACEMENT }
      changed = true
    }
    // agent.defaultModel 形如 "provider:modelId"；alias 写法同样接住
    const dm = agent.defaultModel
    if (typeof dm === 'string') {
      const sep = dm.indexOf(':')
      const provName = sep >= 0 ? dm.slice(0, sep) : ''
      const modelName = sep >= 0 ? dm.slice(sep + 1) : ''
      if (provName === 'deepseek' && (modelName === RETIRED || modelName === RETIRED_ALIAS)) {
        if (ensureReplacementInPool(raw, 'deepseek', REPLACEMENT)) changed = true
        agent.defaultModel = `deepseek:${REPLACEMENT}`
        changed = true
      }
    }
  }

  return changed
}

/**
 * One-shot migration: 官方 deepseek 供应商退役 deepseek-v4-flash（2026-10-04）。
 * 定价表只剩 deepseek-flash（版本 DeepSeek-V4.1-Flash）与 deepseek-v4-pro。旧名仍可
 * 调用，但模型已下线，请求由 V4.1 Flash 按 Flash 价格承接。
 *
 * 只动 provider 名恰好是 `deepseek` 的条目。火山方舟 / OpenCode Go / 硅基流动上的
 * 同名 id 是那些网关自己的模型名，不在这里改。
 *
 * 快照里已有 deepseek-flash 时删掉旧条目；没有则把旧 id 改名（保留用户调过的窗口）。
 * 缺的视觉/定价由随后的 preset backfill 按新 id 补。同时改写官方 provider 上指向
 * 旧 id 或短名 v4-flash 的 defaultModel / visionModel / worker / review / greeting / compact。
 *
 * 幂等。Mutates `raw` in place. Returns true if any value was changed.
 */
export function migrateDeepseekV4FlashRetirement(raw: Record<string, unknown>): boolean {
  const RETIRED = 'deepseek-v4-flash'
  const RETIRED_ALIAS = 'v4-flash'
  const REPLACEMENT = 'deepseek-flash'
  let changed = false

  const isRetired = (name: unknown): boolean => name === RETIRED || name === RETIRED_ALIAS

  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const ds = providers?.['deepseek'] as Record<string, unknown> | undefined
  if (!isOfficialDeepseek(ds)) return false
  if (retireProviderModel(ds, RETIRED, REPLACEMENT)) changed = true

  const redirectRef = (value: string): { next: string; keyId?: string } | undefined => {
    const parts = value.split(':')
    if (parts.length < 2 || parts[0] !== 'deepseek') return undefined
    if (!isRetired(parts[parts.length - 1])) return undefined
    parts[parts.length - 1] = REPLACEMENT
    // 三段式钉 key：补池落点与被引用 key 对齐（key 不存在时 ensure 内落并集兜底）。
    return { next: parts.join(':'), keyId: parts.length === 3 ? parts[1] : undefined }
  }

  // 引用改指 REPLACEMENT 前保证它在被引用 key 的池可达——否则迁移制造悬空引用
  // （keyId 分支只认该 key 的池；见 ensureReplacementInPool 头注释）。幂等由池内
  // 查重守卫，逐引用调用安全：钉不同 key 的引用各自需要本 key 池可达，不能用
  // 「只补一次」的 once 守卫合并。
  const ensurePool = (keyId?: string): void => {
    if (ensureReplacementInPool(raw, 'deepseek', REPLACEMENT, keyId)) changed = true
  }

  const redirectProfile = (profile: unknown): void => {
    if (!profile || typeof profile !== 'object') return
    const p = profile as Record<string, unknown>
    if (p.provider === 'deepseek' && isRetired(p.model)) {
      ensurePool()
      p.model = REPLACEMENT
      changed = true
    }
  }

  const agent = raw.agent as Record<string, unknown> | undefined
  if (agent) {
    const vm = agent.visionModel as Record<string, unknown> | undefined
    if (vm && vm.provider === 'deepseek' && isRetired(vm.model)) {
      ensurePool()
      agent.visionModel = { ...vm, model: REPLACEMENT }
      changed = true
    }
    if (typeof agent.defaultModel === 'string') {
      const redirected = redirectRef(agent.defaultModel)
      if (redirected) {
        ensurePool(redirected.keyId)
        agent.defaultModel = redirected.next
        changed = true
      }
    }
    const greeting = agent.greeting as Record<string, unknown> | undefined
    if (greeting && greeting.model === RETIRED) {
      ensurePool()
      greeting.model = REPLACEMENT
      changed = true
    }
    const review = agent.review as Record<string, unknown> | undefined
    const reviewProfiles = review?.profiles as Record<string, unknown> | undefined
    if (reviewProfiles) {
      for (const profile of Object.values(reviewProfiles)) redirectProfile(profile)
    }
  }

  const compact = raw.compact as Record<string, unknown> | undefined
  if (compact && compact.model === RETIRED) {
    ensurePool()
    compact.model = REPLACEMENT
    changed = true
  }

  const workers = raw.workers as Record<string, unknown> | undefined
  const profiles = workers?.profiles as Record<string, unknown> | undefined
  if (profiles) {
    for (const profile of Object.values(profiles)) redirectProfile(profile)
  }

  // 悬空守卫（2026-10-08，3.28→3.29 已迁移用户缺口）：上面的补池只在「确有引用
  // 被重定向」时发生。已迁移用户（引用早已 = REPLACEMENT、池里却没有它——设置页
  // 剪枝或 keys 池形态）升级后不再产生任何重定向动作，补池永不触发、悬空持续
  // （每次启动报「不在 provider 下」并位置性回退；桌面 resume 链在默认模型也不可
  // 用时直接 fail-closed「请开新会话继续」）。这里不依赖动作，复查**硬引用位点**
  // （defaultModel / visionModel）：指向 REPLACEMENT 而契约池不可达 → 补池
  // （幂等——池内查重；仅当确有引用时补）。
  //
  // 范围刻意不收 greeting / compact / workers / review（弱引用位点）：preset 建立的
  // config 快照在磁盘上就带着这些缺省引用（compact.model / greeting.model /
  // worker[cheap-flash].model 均 = 'deepseek-flash'——provider 建立时写入、几乎人人
  // 都有）。把它们纳入守卫会让「用户在设置页主动把 flash 剪掉」被反复补回
  // （remove-model 语义被破坏，探针实测）。弱引用悬空由各自回退链兜底；硬引用
  // 悬空没有可接受的回退（改指=静默换档，不补=启动告警+resume 死路）。
  // 引用形态判据（parseModelRef + disambiguateKeyPrefix 语义，2026-10-08 审查收窄）：
  //   deepseek-flash                    裸 id——全 provider 扫描：仅当**没有其他
  //                                     provider 的契约池持有该 id** 才判指向本档。
  //                                     否则引用由用户自建 provider 的同名模型承接、
  //                                     并不悬空，把官方 preset 补进 deepseek 池就是
  //                                     无差别回流（剪枝语义被破坏）。
  //   deepseek:deepseek-flash           限定 provider——明确的官方归属。
  //   deepseek:<keyId>:deepseek-flash   限定 key——补池落点必须是被引用的 key
  //                                     （keyId 分支只认该 key 的池）；中间段不是
  //                                     现存 key id 时按消歧语义整段是模型 id
  //                                     （≠ 本档），补哪都救不了，不判指向（少做
  //                                     侧——伪造 key 比悬空更难排查）。
  const poolHoldsId = (prov: unknown, id: string): boolean => {
    if (!prov || typeof prov !== 'object') return false
    const p = prov as Record<string, unknown>
    const has = (models: unknown): boolean =>
      Array.isArray(models) && models.some(m =>
        !!m && typeof m === 'object' && (m as { id?: unknown }).id === id)
    const keys = p.keys
    if (Array.isArray(keys) && keys.length > 0) {
      return keys.some(k => !!k && typeof k === 'object' && has((k as Record<string, unknown>).models))
    }
    return has(p.models)
  }
  const dsKeyIds = new Set(
    (Array.isArray(ds?.keys) ? ds.keys : [])
      .filter(k => !!k && typeof k === 'object')
      .map(k => (k as { id?: unknown }).id),
  )
  const pointsToReplacement = (ref: unknown): { referenced: boolean; keyId?: string } => {
    if (typeof ref !== 'string') return { referenced: false }
    if (ref === REPLACEMENT) {
      const heldElsewhere = Object.entries(providers ?? {}).some(([name, prov]) =>
        name !== 'deepseek' && poolHoldsId(prov, REPLACEMENT))
      return { referenced: !heldElsewhere }
    }
    const parts = ref.split(':')
    if (parts.length < 2 || parts[0] !== 'deepseek') return { referenced: false }
    if (parts.length === 2) return { referenced: parts[1] === REPLACEMENT }
    if (parts.length === 3 && parts[2] === REPLACEMENT && dsKeyIds.has(parts[1])) {
      return { referenced: true, keyId: parts[1] }
    }
    return { referenced: false }
  }
  const dmRef = pointsToReplacement(agent?.defaultModel)
  let replacementReferenced = dmRef.referenced
  let referencedKeyId = dmRef.keyId
  if (!replacementReferenced && agent) {
    const vm = agent.visionModel as Record<string, unknown> | undefined
    replacementReferenced = !!vm && vm.provider === 'deepseek' && vm.model === REPLACEMENT
  }
  if (replacementReferenced && ensureReplacementInPool(raw, 'deepseek', REPLACEMENT, referencedKeyId)) changed = true

  return changed
}
