/**
 * Curated MCP server presets for one-click "discover & enable" in the desktop
 * Settings UI. Mirrors the provider-preset pattern (src/config/provider-presets.ts):
 * a static catalog the server exposes via `GET /mcp/presets`, with the set of
 * already-configured ids so the UI can render an "add / configured" state.
 *
 * Presets that need secrets declare `requiredEnv` — the UI collects those keys
 * inline and passes them as the server's `env` (same plaintext-in-config
 * tradeoff as provider API keys).
 */

import type { McpTransportType } from './types.js'
import type { McpOAuthConfig } from './oauth/types.js'

export interface McpPresetEnvField {
  /** Env var name passed to the MCP server process (e.g. GITHUB_PERSONAL_ACCESS_TOKEN). */
  key: string
  /** Human label for the input. */
  label: string
  /** Optional help / where to obtain the value. */
  help?: string
}

/** Upstream maintainer shown on the discovery card — so a user filing a bug
 *  knows whose project they are wiring in before they look for the repo. */
export interface McpPresetAuthor {
  /** Display name (GitHub handle or org). */
  name: string
  /** Profile URL, opened from the author label. */
  url?: string
}

export interface McpPreset {
  id: string
  name: string
  description: string
  /** Rough grouping for the discovery grid. */
  category: 'dev' | 'productivity' | 'communication' | 'knowledge'
  transport: McpTransportType
  /** stdio */
  command?: string
  args?: string[]
  /** remote */
  url?: string
  /** Secrets the preset needs; collected inline and stored as `env`.
   *  Omit if using OAuth (auth.oauth). */
  requiredEnv?: McpPresetEnvField[]
  /** OAuth-based auth for this preset. Takes precedence over requiredEnv when set. */
  auth?: McpOAuthConfig
  /** A few representative tool names to set expectations (not exhaustive). */
  expectedTools?: string[]
  /** Upstream maintainer — rendered on the discovery card. Optional because
   *  first-party curated entries may have no single maintainer; presets that
   *  wrap someone else's server should carry this + repoUrl, so the user can
   *  attribute it (and report upstream) before wiring it in. */
  author?: McpPresetAuthor
  /** Upstream repository URL — rendered as the card's "repository" entry. */
  repoUrl?: string
  docsUrl?: string
  /** 按需启用：卡片上打一个显式标记，告诉用户这一条不是开箱即用的默认项。
   *  语义与 McpSettings 的 opt-in 一致——列出预设不写任何配置、不拉起进程，
   *  只有用户点「启用」才写入 config 并启动（测试见 mcp-presets.test.ts 的
   *  「默认关闭：列出预设不写 config」）。 */
  optIn?: boolean
}

export const MCP_PRESETS: McpPreset[] = [
  // 排首位（2026-09-30）：天枢官方 MCP 是三端 Agent「开发 → 验收 → 返修」闭环的
  // 主入口，值得占发现页第一屏；但它是**按需启用**的（optIn）——列卡片不写配置、
  // 不拉进程，用户点「启用」才生效。
  {
    id: 'tianshu-mcp',
    name: 'Tianshu MCP',
    description: '天枢官方 MCP server —— 调度 TraeWork / ZCode / Codex 三个桌面端 Agent 完成「开发 → 验收 → 失败返修 → 再验收」闭环（run_task / verify_task / manage_task 等 8 个工具）。默认关闭：点「启用」才会写入配置并拉起进程，首次 npx 拉包可能需要数十秒。',
    category: 'dev',
    transport: 'stdio',
    // 走 npx 分发（与生态其余预设一致）：零前置即可试用。若握手超时，
    // 可改为「全局安装直调」——`npm install -g tianshu-mcp` 后把 command
    // 填成 `tianshu-mcp`、args 清空（上游 issue #145 记录了两条已知坑：
    // npx 冷启动超窗、内置 node-runtime 的 npx 重写）。
    // 实测（macOS / node 24.18，经 createTransport 与 McpManager 两条真实链路）：
    // 握手 6537ms（首次含拉包）/ 1554ms（npm 缓存后），工具面 9 个注册为
    // mcp__tianshu-mcp__*，state=connected。也就是说 issue #72 的「npx 超窗」
    // 与本仓当前默认不符——启动窗口早已放宽到 60s（transport-factory.ts 的
    // DEFAULT_MCP_TIMEOUT_MS），6.5s 离上限很远。
    // 复核入口（探针是一次性的，数字靠这两条命令现取）：
    //   RIVET_MCP_LIVE=1 npm exec -- tsx --test src/server/__tests__/mcp-presets.test.ts
    //   npm exec -- tsx scripts/smoke-mcp-presets.ts --only tianshu-mcp   # 真实握手 + 工具面
    // 握手毫秒数随机器与 npm 缓存浮动，看的是「能不能连上、工具面覆盖声明」。
    // 2026-09-14 冒烟复跑：工具面已是 11 个（该包在持续升版，上面那个 9 是当时的
    // 快照）。expectedTools 列的 9 个仍全部返回——它是代表性列举，不是全集。
    // 2026-10-08：0.9.0 真实握手返回 8 个工具；管理/返修收口到 manage_task。
    command: 'npx',
    args: ['-y', 'tianshu-mcp'],
    expectedTools: [
      'run_task',
      'query_task',
      'manage_task',
      'verify_task',
      'query_info',
      'wait_task',
      'prepare_visual_baseline',
      'approve_visual_baseline',
    ],
    author: { name: 'lanlan0811', url: 'https://github.com/lanlan0811' },
    repoUrl: 'https://github.com/lanlan0811/tianshu-mcp',
    optIn: true,
  },
  {
    id: 'context7',
    name: 'Context7',
    description: '实时库文档查询 —— 为编码 agent 提供最新框架/库 API 参考，减少幻觉',
    category: 'knowledge',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    // 工具名取自 2026-09-14 的冒烟实测（context7-mcp 4.1.1）：上游已把
    // `get-library-docs` 改名为 `query-docs`——改名前卡片一直在给用户列一个
    // 不存在的工具，而静态表不会自己发现这件事。核对靠 `npm run smoke:mcp`。
    expectedTools: ['resolve-library-id', 'query-docs'],
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: '读写 issues / PR / 仓库文件 —— 让 agent 直接在 GitHub 上协作',
    category: 'dev',
    // stdio 分发给不了这个 server：官方 MCP server 已改写为 Go
    // （github/github-mcp-server），npm 上没有官方包；生态里同名的
    // `github-mcp-server` 是个人仓库（jungchihoon/），把用户的 repo 权限交给它，
    // 与本条目「安全可维护」的前提冲突。故走官方 remote 托管端点：零本地依赖、
    // 由 GitHub 维护，且天枢的 remote + OAuth 链路早已接线（manager.ts:399-408
    // 的 cfg.command 分支——stdio 给 env，remote 给 Authorization header）。
    // 代价要认清：remote 只消费 headers 不消费 env，所以这里**不声明 requiredEnv**
    // ——手填 PAT 是 stdio 形态才有的路径，本条只能走 OAuth。
    transport: 'streamableHttp',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: { type: 'oauth' as const, provider: 'github', scopes: ['repo', 'read:org'] },
    author: { name: 'GitHub', url: 'https://github.com/github' },
    repoUrl: 'https://github.com/github/github-mcp-server',
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  // Slack 暂不设条目（有意留白，不是遗漏）：@modelcontextprotocol/server-slack
  // 已于 2025-04-25 废弃（issue #150），而 npm 上的候选
  // （slack-mcp-server@1.3.0 → korotovsky/、@ubie-oss/slack-mcp-server）经核
  // 均为个人仓库。Slack bot token 的权限面（读频道历史 + 代发消息）比 repo 更敏感，
  // 不宜作为默认推荐交给个人维护的包。找到可信的现役实现再放回——期间用户仍可
  // 自行添加自定义 server。
  {
    id: 'notion',
    name: 'Notion',
    description: '检索与更新 Notion 页面 / 数据库 —— 把项目知识接进 agent',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    auth: { type: 'oauth' as const, provider: 'notion' },
    requiredEnv: [
      {
        key: 'NOTION_API_KEY',
        label: 'Notion Integration Token',
        help: '在 notion.so/my-integrations 创建 internal integration 并共享目标页面。使用 OAuth 可跳过。',
      },
    ],
    expectedTools: ['search', 'query_database', 'update_page'],
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    description: '检索与读取 Google Drive 文件（含 Sheets 读写）—— 把云盘里的杂乱文档接进 agent。外部文档内容遵循来源核验纪律（格式完整不等于可信）',
    category: 'knowledge',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@isaacphi/mcp-gdrive'],
    requiredEnv: [
      {
        key: 'CLIENT_ID',
        label: 'Google OAuth Client ID',
        help: 'Google Cloud Console → APIs & Services → Credentials 创建 OAuth 客户端（Desktop 类型），并启用 Drive / Sheets API',
      },
      {
        key: 'CLIENT_SECRET',
        label: 'Google OAuth Client Secret',
        help: '同一 OAuth 客户端的 secret',
      },
      {
        key: 'GDRIVE_CREDS_DIR',
        label: '凭据缓存目录',
        help: '存放 OAuth token 的本地目录（如 ~/.config/mcp-gdrive），首次连接会弹浏览器授权',
      },
    ],
    expectedTools: ['gdrive_search', 'gdrive_read_file', 'gsheets_read'],
    docsUrl: 'https://github.com/isaacphi/mcp-gdrive',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '管理 Linear issues / 项目 —— agent 可创建、更新、检索任务',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-linear'],
    auth: { type: 'oauth' as const, provider: 'linear', scopes: ['read', 'write'] },
    requiredEnv: [
      { key: 'LINEAR_API_KEY', label: 'Linear API Key', help: '在 Linear Settings → API → Personal API keys 生成。使用 OAuth 可跳过。' },
    ],
    expectedTools: ['list_issues', 'create_issue', 'update_issue'],
    docsUrl: 'https://github.com/jerhadf/linear-mcp-server',
  },
]

/** Look up a preset by id. */
export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id)
}
