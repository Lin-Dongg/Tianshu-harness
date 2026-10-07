/**
 * 太一提示词变体 fixture —— 对照试验（docs/experiments/2026-10-07-star-domain-prompt-optimization.md 阶段1）
 *
 * 变体只改 volatileBlock（唯一进 frozen 前缀的字段；systemPromptSuffix 无生产消费者，
 * 见 assembly-audit.test.ts:146 / delegate-task.ts:64 —— 文档的 A-B 组因此行为等价，B 组省略）：
 *   A = 完整版（现状 STAR_DOMAINS.taiyi.volatileBlock，~1800 字）
 *   C = 精简版（文档给定，~800 字）
 *
 * 变体文本在实验脚本里自建域 def 注入，不改动 star-domain-data.ts ——
 * 守护测试与真实用户零影响；注入路径与「真发布 C 版」逐字节等价
 * （同一 setActiveDomain → <star-domain> 渲染）。
 */

import { STAR_DOMAINS } from '../../src/agent/star-domain-data.js'
import type { ActiveStarDomain } from '../../src/agent/star-domain.js'

export type TaiyiVariant = 'A' | 'C'

/** C 组：精简核心意象（逐字取自实验文档 2026-10-07 阶段1「精简版 volatileBlock」） */
export const TAIYI_VOLATILE_CONDENSED = `你是太一——虚空中的一个点。众星旋转，此处不动。

【核心姿态】
得一：动手之前，让问题停一下。
守一：结果不证明对错，绿不是功成，红不是失败。
用一：慢下来的是催促，不是手。

【关键方法】
守黑：白会自己报信，黑坏了没声音。依赖、约定、上一动留的痕——说"成了"前先摸这些线。
观复：造的东西要看它再来一次的样子。复命曰常，知常曰明。
探针与取证：直接观察先行，层层推断后至。相邻行、时间戳、磁盘证据是归因的骨头。
阴阳：代码绿了是阳（显现），路标留了是阴（完成）。急着赶下一阳而跳过阴，如只吸不呼。

【收口】
复归于无极：到站时把路标留下，把尘留在路上。`

/** 变体 → 注入用的太一域 def（id/name/motto/courageThreshold 恒取生产太一，只换 volatileBlock）。 */
export function taiyiVariantDomain(variant: TaiyiVariant): ActiveStarDomain {
  const base = STAR_DOMAINS.taiyi
  return {
    id: base.id,
    name: base.name,
    volatileBlock: variant === 'C' ? TAIYI_VOLATILE_CONDENSED : base.volatileBlock,
    motto: base.motto,
    courageThreshold: base.courageThreshold,
  }
}

/** 变体指纹：用于核验注入确实生效（A/C 各含对方不含的独有串）。
 *  注意：不能用 motto 里的句子（「天得一以清」在 <star-domain motto> 里恒在场，会假阳性）。 */
export function variantMarker(variant: TaiyiVariant): string {
  return variant === 'C' ? '【核心姿态】' : '你就是太一'
}
