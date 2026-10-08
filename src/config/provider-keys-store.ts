/**
 * provider-keys-store — 多 key 池的磁盘边界（A′：keys 移出 config.json）。
 *
 * 为什么单独成文件：`keys` 存在 config.json 里时，旧版 rivet 的 `z.object`
 * 不认识该字段，loadConfig 静默 strip、saveConfig 原样写回 —— 一次无关写入就
 * 不可逆地抹掉整个 key 池（复现见 docs/plans/provider-keys-cross-version-compat.md §1）。
 * 把 keys 搬到旧版视野之外的文件后，冲突不是被缓解，而是**无法发生**。
 *
 * 命名空间说明：文件名带 `provider-` 前缀，位于 RIVET_HOME 下、与 secrets.json
 * 同级。所有配置层 JSON（config.json / secrets.json / connect-draft.json）都在这一
 * 级目录，靠名字互不冲突。
 *
 * 读取是 fail-open（与 secrets-store 同规）：文件缺失/损坏返回 undefined，由
 * loadConfig 回退到 config.json 里的历史 keys（迁移源），绝不因读不到就丢配置。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { rivetHome, userConfigPath } from './paths.js'
import { providerKeySchema, type ProviderKeyConfig, type ProviderConfig } from './schema.js'
import { migrateDeepseekVisionExpRetirement, migrateDeepseekV4FlashRetirement } from './preset-model-retirement.js'
import { backfillModelFromPreset } from './preset-model-backfill.js'

/** 文件形状版本：与 secrets-store 的 `version: 1` 同规。 */
export const PROVIDER_KEYS_FILE_VERSION = 1

export interface ProviderKeysFile {
  version: typeof PROVIDER_KEYS_FILE_VERSION
  /** provider 名 → 该 provider 的 key 池。空池的 provider 不落条目。 */
  providers: Record<string, ProviderKeyConfig[]>
}

/** keys 文件路径——与 config.json 同目录（honors RIVET_CONFIG_PATH / RIVET_HOME）。 */
export function providerKeysPath(base?: string): string {
  if (base) return join(base, 'provider-keys.json')
  try {
    return join(dirname(userConfigPath()), 'provider-keys.json')
  } catch {
    return join(rivetHome(), 'provider-keys.json')
  }
}

/**
 * 读 keys 文件。不计抛：缺失/非法 JSON/形状不符都返回 undefined（调用方决定回退）。
 * 逐条过 providerKeySchema 校验，坏条目丢弃而不是整文件作废——与「宁可少一条也不
 * 全丢」的同层取舍一致。
 */
export function readProviderKeysFile(base?: string): ProviderKeysFile | undefined {
  const path = providerKeysPath(base)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.version !== PROVIDER_KEYS_FILE_VERSION) return undefined
  const rawProviders = record.providers
  if (rawProviders === null || typeof rawProviders !== 'object' || Array.isArray(rawProviders)) {
    return undefined
  }
  const providers: Record<string, ProviderKeyConfig[]> = {}
  for (const [name, value] of Object.entries(rawProviders as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const keys: ProviderKeyConfig[] = []
    for (const entry of value) {
      const result = providerKeySchema.safeParse(entry)
      if (result.success) keys.push(result.data)
    }
    if (keys.length > 0) providers[name] = keys
  }
  return { version: PROVIDER_KEYS_FILE_VERSION, providers }
}

/**
 * 写 keys 文件（原子 + 0600）。空池不写空对象占位：所有 provider 都无 keys 时
 * 直接落一个空 providers 文件——保持文件存在性稳定，便于读者区分「没有文件」。
 */
export function writeProviderKeysFile(file: ProviderKeysFile, base?: string): void {
  const path = providerKeysPath(base)
  writeFileAtomicSync(path, JSON.stringify(file, null, 2) + '\n')
}

/** 文件系统 mode（0600）——仅当文件存在时有意义。测试与诊断用。 */
export function providerKeysFileMode(base?: string): number | undefined {
  const path = providerKeysPath(base)
  if (!existsSync(path)) return undefined
  return statSync(path).mode & 0o777
}

/**
 * 注入侧（loadConfig 收尾调用）：把文件里的池设为内存权威，并在文件缺失时把内存
 * 里的池一次性落盘（存量 config.json 的迁移路径）。
 *
 * 必须在 `migrateProviderToKeys` **之后**调用：那个函数在 config.json 无 keys 时
 * 只合成 keys[0]（池退化为单条），靠文件覆盖才能恢复完整池。
 * 原地修改 providers；写盘失败静默降级（读路径不因写失败中断）。
 *
 * `options.agent`：退役迁移的悬空引用守卫要复查的硬引用位点（defaultModel /
 * visionModel）。外部池形态下 config.json 无 keys，注入前那遍守卫只能修顶层快照
 * （契约层不读），必须以注入后的真实池为准重跑——不传 agent 时重跑只有
 * `{ provider }`，守卫无引用可查、永不触发（2026-10-08 实证：池=[v4-pro] +
 * defaultModel=deepseek-flash 时 flash 只被补进无人读的顶层快照，悬空持续）。
 */
export function injectProviderKeys(
  providers: Record<string, ProviderConfig>,
  options?: { agent?: unknown },
): void {
  const file = readProviderKeysFile()
  const toPersist: ProviderKeysFile = { version: PROVIDER_KEYS_FILE_VERSION, providers: {} }
  let stale = false
  for (const [name, provider] of Object.entries(providers)) {
    const fromFile = file?.providers[name]
    if (fromFile && fromFile.length > 0) provider.keys = fromFile
  }
  // loadConfig 里的退役迁移发生在**这些外部池注入之前**——池里的退役 id 不在它的
  // 视野内，于是「设置页剪过的池 / 老 provider-keys.json」会把退役档复活，而选择器
  // 与请求端读的正是 keys[].models。这里对事实源再跑一遍退役与预设元数据回填，
  // 结果幂等落盘（stale → 写文件；重新加载得到同一份文件）。
  const raw = {
    provider: { providers },
    ...(options?.agent !== undefined ? { agent: options.agent } : {}),
  } as unknown as Record<string, unknown>
  if (migrateDeepseekVisionExpRetirement(raw)) stale = true
  if (migrateDeepseekV4FlashRetirement(raw)) stale = true
  for (const [name, provider] of Object.entries(providers)) {
    for (const key of provider.keys ?? []) {
      let repairedAny = false
      const repairedModels = key.models.map(model => {
        const repaired = backfillModelFromPreset(name, model)
        if (repaired !== model) { repairedAny = true; stale = true }
        return repaired
      })
      // 无改动时保持原数组引用：内存合成路径靠 `keys[0].models === models` 维持兼容
      // 槽位的共身份（provider-keys.test.ts 的 legacy 形态断言）。无条件替换会断开它
      // ——PR 原版如此，作者自述未跑全量，收编时由该既有测试抓出。
      if (repairedAny) key.models = repairedModels
    }
    const fromFile = file?.providers[name]
    const effective = provider.keys
    if (effective && effective.length > 0) {
      toPersist.providers[name] = effective
      if (!fromFile || fromFile.length === 0) stale = true
    }
  }
  if (stale) {
    try {
      writeProviderKeysFile(toPersist)
    } catch {
      // best-effort
    }
  }
}

/**
 * 剥离侧（saveConfig 调用）：剥掉内存里的 keys 池、剥掉每条 key 的明文，
 * 返回该写入 keys 文件的载荷。原地修改 providers（调用方传入的应是深拷贝）。
 */
export function stripProviderKeys(providers: Record<string, ProviderConfig>): ProviderKeysFile {
  const keysFile: ProviderKeysFile = { version: PROVIDER_KEYS_FILE_VERSION, providers: {} }
  for (const provider of Object.values(providers)) {
    // 多 key 池同样剥明文：每个 key 的凭据只以 keyRef / apiKeyEnv 落盘
    // （loadConfig 已把 keys 内的内联明文迁进 secrets.json 并回填 keyRef）。
    for (const key of provider.keys ?? []) key.apiKey = undefined
    if (provider.keys && provider.keys.length > 0) {
      keysFile.providers[provider.name] = provider.keys
      delete (provider as unknown as { keys?: unknown }).keys
    }
  }
  return keysFile
}
