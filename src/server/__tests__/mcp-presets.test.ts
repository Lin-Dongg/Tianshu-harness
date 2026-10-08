import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MCP_PRESETS, findMcpPreset } from '../../mcp/presets.js'
import { buildMcpRoutes } from '../mcp-api.js'
import { createTransport } from '../../mcp/transport-factory.js'

test('MCP_PRESETS have unique ids', () => {
  const ids = MCP_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('each preset is a well-formed transport config', () => {
  for (const p of MCP_PRESETS) {
    if (p.transport === 'stdio') {
      assert.ok(p.command, `${p.id} stdio preset must have a command`)
      assert.ok(!p.url, `${p.id} stdio preset must not have a url`)
    } else {
      assert.ok(p.url, `${p.id} sse preset must have a url`)
      assert.ok(!p.command, `${p.id} sse preset must not have a command`)
    }
    for (const env of p.requiredEnv ?? []) {
      assert.ok(env.key && env.label, `${p.id} requiredEnv fields need key + label`)
    }
  }
})

test('findMcpPreset resolves by id', () => {
  assert.equal(findMcpPreset('github')?.name, 'GitHub')
  assert.equal(findMcpPreset('nope'), undefined)
})

// ── 推荐列表的包新鲜度（issue #150：GitHub / Slack 两个预设指向已废弃的包） ──
// 这张表是静态的：上游把包标成 deprecated 不会自动反映进来，而「推荐」是用户
// 信任的入口——指向无人维护的包，等于让用户把 repo 权限挂在停更依赖上。
// 三条断言分工：第一条锁住这次修的路径不被改回去，第二条挡住同族包的再次混入，
// 第三条联网兜住将来新增的废弃项（门控，不拖慢日常跑）。

test('GitHub 预设走官方 remote 端点，不再依赖已废弃的 npm 包', () => {
  const gh = findMcpPreset('github')
  assert.ok(gh, 'github preset must exist')
  assert.equal(gh.transport, 'streamableHttp')
  assert.equal(gh.url, 'https://api.githubcopilot.com/mcp/')
  // command 的存在与否就是 manager.ts:399 的分支判据：带 command 走 stdio（token
  // 注入 env），不带才走 remote（token 注入 Authorization header）。混装 = token
  // 注进没人读的地方，表现为连上了但 401。
  assert.equal(gh.command, undefined, 'remote 预设不得带 command')
  assert.equal(gh.args, undefined, 'remote 预设不得带 args')
  assert.equal(gh.auth?.provider, 'github', '鉴权仍走 github OAuth')
})

test('推荐列表不得指向 @modelcontextprotocol/server-* 系列包（该系列已整体废弃）', () => {
  for (const p of MCP_PRESETS) {
    for (const a of p.args ?? []) {
      assert.ok(
        !a.startsWith('@modelcontextprotocol/server-'),
        `${p.id} 仍指向已废弃包 ${a}——见 issue #150`,
      )
    }
  }
})

test('推荐列表里的 npm 包未被上游废弃（RIVET_MCP_LIVE=1 门控，需联网）', { skip: process.env.RIVET_MCP_LIVE !== '1' }, () => {
  const deprecated: string[] = []
  for (const p of MCP_PRESETS) {
    if (p.transport !== 'stdio' || p.command !== 'npx') continue
    const pkg = (p.args ?? [])[1]
    if (!pkg) continue
    const out = execFileSync('npm', ['view', pkg, 'deprecated'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (out.trim()) deprecated.push(`${p.id} → ${pkg}: ${out.trim()}`)
  }
  assert.deepEqual(
    deprecated,
    [],
    `以下预设指向已废弃的包（改走官方端点，或先摘掉条目再找替代）：\n${deprecated.join('\n')}`,
  )
})

/**
 * 隔离 RIVET_HOME——预设/配置读写都落在这个根下（同 mcp-hot-add.test.ts 的模式）。
 */
function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-presets-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = dir
  return fn().finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

// ── 来源标注（issue #145：接入的第三方 MCP 必须可归因） ────────────────
// 卡片要显示「谁维护的、仓库在哪」，字段形态由这里兜底：缺名字、非 https
// 的链接在 UI 上会变成打不开的死链——与其上线后靠肉眼发现，不如在这里红。

test('preset provenance: author / repoUrl / docsUrl are well-formed when present', () => {
  for (const p of MCP_PRESETS) {
    if (p.author) {
      assert.ok(p.author.name.trim().length > 0, `${p.id} author needs a display name`)
      if (p.author.url) assert.match(p.author.url, /^https:\/\/\S+$/, `${p.id} author.url must be https`)
    }
    if (p.repoUrl) assert.match(p.repoUrl, /^https:\/\/\S+$/, `${p.id} repoUrl must be https`)
    if (p.docsUrl) assert.match(p.docsUrl, /^https:\/\/\S+$/, `${p.id} docsUrl must be https`)
  }
})

test('tianshu-mcp preset: 官方 MCP 条目契约（作者 / 仓库 / 工具面）', () => {
  const p = findMcpPreset('tianshu-mcp')
  assert.ok(p, 'tianshu-mcp preset must exist')
  assert.equal(p.transport, 'stdio')
  assert.equal(p.command, 'npx')
  assert.deepEqual(p.args, ['-y', 'tianshu-mcp'])
  assert.equal(p.author?.name, 'lanlan0811', '作者信息缺失则卡片无从归因')
  assert.equal(p.author?.url, 'https://github.com/lanlan0811')
  assert.equal(p.repoUrl, 'https://github.com/lanlan0811/tianshu-mcp')
  assert.deepEqual(p.expectedTools, [
    'run_task', 'query_task', 'manage_task', 'verify_task', 'query_info',
    'wait_task', 'prepare_visual_baseline', 'approve_visual_baseline',
  ], '0.9.0 真实握手工具面')
})

// ── 默认关闭 / 显式开启（用户对本次接入的硬要求） ─────────────────────
// 「默认关闭」不是一句注释：列出预设必须不产生任何配置写入，只有 POST
// /mcp/servers（桌面端点「启用」）才让 id 出现在 configuredIds 里。
// 若哪天有人把内置预设预置进默认 config，这条会红。

test('tianshu-mcp 默认关闭：列出预设不写 config，configuredIds 不含它', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes(() => null, 'secret-token')
    const res = await routes['GET /mcp/presets']!({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
    assert.equal(res.status, 200)
    const body = res.body as { presets: Array<{ id: string }>; configuredIds: string[] }
    assert.ok(body.presets.some((p) => p.id === 'tianshu-mcp'), '预设目录里必须有它')
    assert.ok(!body.configuredIds.includes('tianshu-mcp'), '列出预设不得把它标成已配置')

    const { loadConfig } = await import('../../config/manager.js')
    assert.equal(
      loadConfig().mcp.servers['tianshu-mcp'],
      undefined,
      '默认关闭：不得预置进 mcp.servers（否则开箱即拉起子进程）',
    )
  })
})

test('显式开启：POST /mcp/servers 之后 id 才出现在 configuredIds', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes(() => null, 'secret-token')
    const preset = findMcpPreset('tianshu-mcp')!
    const post = await routes['POST /mcp/servers']!(
      { serverId: preset.id, command: preset.command, args: preset.args },
      undefined,
      { authorization: 'Bearer secret-token' },
      undefined,
    )
    assert.equal(post.status, 200)

    const res = await routes['GET /mcp/presets']!({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
    const body = res.body as { configuredIds: string[] }
    assert.ok(body.configuredIds.includes('tianshu-mcp'), '启用后应标记为已配置')
  })
})

test('GET /mcp/presets returns presets + configuredIds (auth-gated)', async () => {
  const routes = buildMcpRoutes(() => null, 'secret-token')
  const handler = routes['GET /mcp/presets']!

  const unauthorized = await handler({}, undefined, {}, undefined)
  assert.equal(unauthorized.status, 401)

  const res = await handler({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
  assert.equal(res.status, 200)
  const body = res.body as { presets: unknown[]; configuredIds: unknown }
  assert.ok(Array.isArray(body.presets))
  assert.equal(body.presets.length, MCP_PRESETS.length)
  assert.ok(Array.isArray(body.configuredIds))
})

// ── live 联调：预设声明的 command/args 能不能真拉起上游 ──────────────────
// 默认跳过（联网 + npx 首次拉包约 10s），CI 不依赖网络。复核时显式开启：
//   RIVET_MCP_LIVE=1 npm exec -- tsx --test src/server/__tests__/mcp-presets.test.ts
//
// 这条同时是 expectedTools 的真判据：卡片把它当「示例」呈现而非穷尽清单，
// 但示例里写的名字必须真在上游工具面上——否则用户照着名字等工具，等不到。
const liveGate = process.env.RIVET_MCP_LIVE === '1'

test(
  'live: tianshu-mcp 预设可真实握手，且上游工具面覆盖 expectedTools 声明的名字',
  { skip: liveGate ? false : '联网 + 拉包测试；设 RIVET_MCP_LIVE=1 显式开启' },
  async () => {
    const preset = findMcpPreset('tianshu-mcp')
    assert.ok(preset?.command, '预设必须带 stdio 启动命令')
    const res = await createTransport(
      { command: preset.command, args: preset.args ?? [] },
      { timeoutMs: 90_000 },
    )
    try {
      const listed = await res.client.listTools()
      const names = listed.tools.map((t) => t.name)
      for (const expected of preset.expectedTools ?? []) {
        assert.ok(names.includes(expected), `上游应暴露 ${expected}；实际：${names.join(', ')}`)
      }
    } finally {
      await res.client.close().catch(() => {})
    }
  },
)
