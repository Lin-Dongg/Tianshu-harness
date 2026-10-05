/**
 * provider-presets-agnes — Agnes AI 预设数据（免费多模态：文本 + 生图）。
 *
 * 独立成文件：provider-presets.ts 是行数棘轮点名的巨石（ceiling 只降不升），
 * 大块纯数据沿「同一 provider 家族」接缝拆出（同 provider-presets-volc.ts 先例）；
 * PROVIDER_PRESETS 的合并与 key→预设 的类型索引仍留在 provider-presets.ts。
 *
 * 官方文档（www.agnes-ai.com/zh-Hans/docs/*，2026-10-02 口径）：
 *   · Base URL：https://apihub.agnes-ai.com/v1。注意旧域名 api.agnes.ai 已停
 *     （DNS 不解析）——若在别处见到该地址不要照抄；视觉校验链路的域名兼容
 *     在 api/vision-model-onboarding.ts。
 *   · 端点面：Chat Completions（/v1/chat/completions）、Responses（/v1/responses）、
 *     Messages（/v1/messages，Anthropic 兼容，x-api-key）——本预设取 OpenAI 协议
 *     主路径；另两条未建对应能力声明（工具面未验证，先不铺）。
 *   · 免费口径：agnes-3.0-flash / agnes-2.5-flash（文本）与 agnes-image-*（生图）
 *     的「现价」为 $0；官方注明为阶段性优惠（刊例价另计、以账户账单为准）——
 *     pricing 按现价记 0 + free: true（schema 语义：真正免费，区别于订阅折算价）。
 *     agnes-2.5-pro 为付费模型（按刊例价计费），不标 free。
 *   · 缓存：定价页列「输入缓存命中」计费项（单价为普通输入的 10%）——服务端
 *     隐式 exact-prefix（与 GLM/LongCat/硅基流动同型）→ prefixCache deepseek-native。
 *     usage 字段形状未实测（无 Key）；mapUsage 在字段缺席时读 0，无损。
 *   · Thinking：官方 OpenAI 面走 chat_template_kwargs.enable_thinking（本仓未建
 *     该通道）→ thinkingBlock / effortFormat 都不声明（不发上游不认识的参数；
 *     档位控件据 resolveEffortSupported 诚实禁用，而非静默丢弃后仍报设置成功）。
 *   · 生图：POST /v1/images/generations，size 必填（1K/2K/3K/4K 档位，可配 ratio）。
 *     生图模型标 supportsImageGen：进桌面端「生图模型」可选池、不进主会话选择器
 *     （两处消费同一标记，见 desktop HomeWelcome / ImageGenModelSettings）。
 *     生图档无官方 token 规格——ctx/max 填占位小值，仅为通过连接向导的元数据
 *     完整性检查（connect-flow 对勾选模型要求 ctx+max 同时在场），该模型只走
 *     images/generations，运行时不对这两个字段做任何消费。
 */

import type { ProviderPreset } from './provider-presets.js'

export const AGNES_PRESETS: Record<'agnes', ProviderPreset> = {
  agnes: {
    key: 'agnes',
    label: 'Agnes AI (免费模型)',
    description: 'Agnes AI 免费档：文本 + 生图模型现价 $0（优惠期），注册拿 Key 即用',
    defaultModelId: 'agnes-3.0-flash',
    keyUrl: 'https://platform.agnes-ai.com/',
    provider: {
      name: 'agnes',
      apiKeyEnv: 'AGNES_API_KEY',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
        toolJsonBug: false,
        prefixCache: 'deepseek-native',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 65_536,
      models: [
        {
          id: 'agnes-3.0-flash',
          description: '免费旗舰：512K 上下文 + 图像输入，Agent 工具编排',
          contextWindow: 512_000,
          maxTokens: 65_536,
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true },
        },
        {
          id: 'agnes-2.5-flash',
          description: '免费主力：512K 上下文 + 图像输入（3.0 的上一代）',
          contextWindow: 512_000,
          maxTokens: 65_536,
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true },
        },
        {
          id: 'agnes-2.5-pro',
          description: '付费旗舰：1M 上下文 + 图像输入（按量计费）',
          contextWindow: 1_000_000,
          maxTokens: 65_536,
          tier: 'strong',
          supportsVision: true,
          pricing: { input: 0.45, output: 0.9, cacheRead: 0.045, cacheWrite: 0.45 },
        },
        {
          id: 'agnes-image-2.5-flash',
          description: '生图专用：文生图/图生图，1K–4K 档位；当前免费',
          contextWindow: 8_192,
          maxTokens: 4_096,
          supportsImageGen: true,
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true },
        },
      ],
      unsupported: [],
    },
  },
}
