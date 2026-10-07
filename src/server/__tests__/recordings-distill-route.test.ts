import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { RECORDING_SCHEMA_VERSION } from '../../prompt/rpa-distill.js'
import type { Config } from '../../config/schema.js'
import { __setProGrantPublicKeyForTests } from '../../config/pro-license.js'
import { makeValidGrant } from '../../config/__tests__/grant-fixtures.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  prompts: string[] = []
  artifacts: Artifact[] = []
  private resolveRun?: () => void
  run(prompt: string, cb: AgentCallbacks) {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  finish() { this.resolveRun?.() }
  abort() { this.resolveRun?.() }
  listArtifacts() { return this.artifacts }
  readArtifact() { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup(config?: Config) {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN, undefined, config))
  return { manager, agents, router }
}

const HEADER = JSON.stringify({ schema: RECORDING_SCHEMA_VERSION, startedAt: 1, platform: 'darwin' })
const CLICK = JSON.stringify({
  ts: 100, type: 'click', app: 'QQ',
  data: { x: 1, y: 2, button: 'left', count: 1, element: { role: 'AXButton', title: '发送', value: '', ancestors: [] } },
})
const JSONL = [HEADER, CLICK].join('\n')

test('distill 路由创建蒸馏会话，prompt 含时间线与工作流路径', async () => {
  const { agents, router } = setup()
  const res = await router('POST', '/recordings/distill', { recordingId: 'rec-abc', jsonl: JSONL }, AUTH)
  assert.equal(res.status, 201)
  const body = res.body as { session: { id: string }; workflowPath: string; eventCount: number; apps: string[] }
  assert.equal(body.workflowPath, '.rivet/recordings/rec-abc.workflow.md')
  assert.equal(body.eventCount, 1)
  assert.deepEqual(body.apps, ['QQ'])
  // createSession 带 prompt → agent 立刻收到蒸馏任务
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(agents.length, 1)
  const prompt = agents[0]!.prompts[0]!
  assert.match(prompt, /AXButton/)
  assert.match(prompt, /\.rivet\/recordings\/rec-abc\.workflow\.md/)
  assert.match(prompt, /验证步骤/)
})

test('distill 路由缺字段与坏 schema 返回 400', async () => {
  const { router } = setup()
  const missing = await router('POST', '/recordings/distill', { recordingId: 'x' }, AUTH)
  assert.equal(missing.status, 400)
  const badSchema = await router(
    'POST', '/recordings/distill',
    { recordingId: 'x', jsonl: JSON.stringify({ schema: 'other/1' }) + '\n' + CLICK },
    AUTH,
  )
  assert.equal(badSchema.status, 400)
  assert.match(String((badSchema.body as { error: string }).error), /unsupported_schema/)
})

test('distill 路由清洗 recordingId 防路径注入', async () => {
  const { router } = setup()
  const res = await router('POST', '/recordings/distill', { recordingId: '../../etc/passwd', jsonl: JSONL }, AUTH)
  // 清洗后剩 "etcpasswd" —— 不含路径分隔符
  assert.equal(res.status, 201)
  const body = res.body as { workflowPath: string }
  assert.ok(!body.workflowPath.includes('..'))
  assert.match(body.workflowPath, /^\.rivet\/recordings\/[a-zA-Z0-9_-]+\.workflow\.md$/)
})

test('distill 路由 Pro 门禁：computerUse 未启用时 403 pro_required', async () => {
  const disabled: Config = {
    ...DEFAULT_CONFIG,
    pro: { ...DEFAULT_CONFIG.pro, enabled: false },
  }
  // 必须隔离 RIVET_HOME：开发机激活过 Pro 时 ~/.rivet/license.json 存在，不隔离
  // 就变成「本机已激活」→ 门禁放行、用例假红（2026-10-06 实测：未隔离 201 !== 403，
  // 指向空 HOME 后 5/5 绿）。与本文件 Pro 放行用例同一范式。
  const home = mkdtempSync(join(tmpdir(), 'distill-nopro-'))
  const prevHome = process.env.RIVET_HOME
  const { router } = setup(disabled)
  const prevEnv = process.env.RIVET_PRO
  process.env.RIVET_HOME = home
  delete process.env.RIVET_PRO
  try {
    const res = await router('POST', '/recordings/distill', { recordingId: 'r', jsonl: JSONL }, AUTH)
    assert.equal(res.status, 403)
    assert.equal((res.body as { error: string }).error, 'pro_required')
  } finally {
    if (prevEnv !== undefined) process.env.RIVET_PRO = prevEnv
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
  }
})

test('distill 路由 Pro 门禁：Pro 启用时放行', async () => {
  // Pro 的唯一正当来源是**签名凭证**（config.pro.enabled 不再是凭据）：
  // 在 RIVET_HOME 下放一份有效签名的 license.json，模拟已激活的付费用户。
  const home = mkdtempSync(join(tmpdir(), 'distill-pro-'))
  const prevHome = process.env.RIVET_HOME
  const { token, publicKeyB64 } = makeValidGrant()
  writeFileSync(join(home, 'license.json'), JSON.stringify({ token, lastVerifiedAt: Date.now() }))
  process.env.RIVET_HOME = home
  __setProGrantPublicKeyForTests(publicKeyB64)
  try {
    const enabled: Config = {
      ...DEFAULT_CONFIG,
      pro: { ...DEFAULT_CONFIG.pro, enabled: false },
    }
    const { router } = setup(enabled)
    const res = await router('POST', '/recordings/distill', { recordingId: 'r', jsonl: JSONL }, AUTH)
    assert.equal(res.status, 201)
  } finally {
    __setProGrantPublicKeyForTests(null)
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
  }
})
