/**
 * 第四批（2026-10-02）：会话/worker 收尾的 tokenUsage 尾账修复回归。
 *
 * 缺陷：meta.tokenUsage 由 append-side listener 在「消息落盘」时快照；最后一次
 * append 之后的记账（turn 末 side-path 等）再无快照机会——收尾不补，尾账永失。
 * 实测：worker-team-T2-a76d5 差 4,307 = 恰好最后一条侧路行；batch-0 同类。
 *
 * 修法（drain 屏障内补终值快照 + 双写点单调守卫）对应三个用例：
 * 1) drain 后 meta 必须含 session 终值（修补前 RED——drain 只刷已排队的旧快照）；
 * 2) 终值小于盘上值时不得倒扣（"仅补写、无守卫"的修法下 RED）；
 * 3) listener 快照同样只增不减（修补前 RED——倒扣会把尾账连同更早的账一起吃掉）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { SessionPersist, getSessionDir } from '../session-persist.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { runWorkerSession } from '../worker-session.js'
import { deriveWorkerSessionId } from '../work-order.js'
import { makeFaultClient } from './helpers/fault-client.js'
import { makeWorkerConfig } from './helpers/worker-fixture.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

function idleClient(): StreamClient {
  return {
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    },
  } as unknown as StreamClient
}

function makeAgent(cwd: string, sessionId: string): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd },
  })
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: idleClient(),
    promptEngine: engine,
    toolRegistry: registry,
    sessionId,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), cwd)
}

function metaPathFor(cwd: string, sessionId: string): string {
  return join(getSessionDir(cwd), `${sessionId}.meta.json`)
}

describe('收尾 tokenUsage 尾账：drain 终值快照 + 单调守卫（第四批）', () => {
  it('drain 屏障补终值快照：末次 append 之后的记账必须落进 meta（修补前 RED）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'drain-tail-'))
    const sessionId = `tail-${Date.now()}`
    const agent = makeAgent(cwd, sessionId)
    // 模拟真实形态：主轮用量 + 其后（无新 append 的）侧路用量。
    // 修补前 drain 只刷已排队快照 → meta 无 tokenUsage（RED）；修补后含终值。
    agent.session.addUsage({ input_tokens: 30_000, output_tokens: 500 })
    agent.session.addSidePathUsage({ input_tokens: 4_307, output_tokens: 200 })

    await agent.drainPersistWrites()

    const metaPath = metaPathFor(cwd, sessionId)
    assert.ok(existsSync(metaPath), 'drain 必须落盘 meta 终值快照')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    assert.equal(meta.tokenUsage?.prompt, 34_307, 'meta 必须含主轮+侧路的 session 终值——尾账丢失即本用例红')
    assert.equal(meta.tokenUsage?.completion, 700)
  })

  it('drain 终值快照单调守卫：终值小于盘上已有值时不得倒扣', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'drain-guard-'))
    const sessionId = `guard-${Date.now()}`
    // 盘上先落一个更大的累计（异常/更大历史值）
    const persist = new SessionPersist(sessionId, cwd)
    persist.updateMetadata({ tokenUsage: { prompt: 100_000, completion: 0, total: 100_000 } })
    await persist.flushSessionBuffer()

    const agent = makeAgent(cwd, sessionId)
    agent.session.addUsage({ input_tokens: 1_000 })
    await agent.drainPersistWrites()

    const meta = JSON.parse(readFileSync(metaPathFor(cwd, sessionId), 'utf-8'))
    assert.equal(meta.tokenUsage?.prompt, 100_000, '终值更小时保留盘上值——meta 单调递增是对账判据的前提')
  })

  it('listener 快照只增不减：续跑 seed 小于盘上值时不得倒扣（修补前 RED）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'listener-guard-'))
    const config = makeWorkerConfig({
      cwd,
      // 预算超时收割（非父信号——后者 caller_aborted 早退）：resolves blocked
      client: makeFaultClient([{ kind: 'idle_stall' }]),
      priorUsage: { input_tokens: 1_000 },
    })
    config.order.budget.timeoutMs = 200
    await runWorkerSession(config) // 首跑建 meta（seed=1,000）

    const metaPath = metaPathFor(cwd, deriveWorkerSessionId(config.order.id, config.sessionNonce))
    const seeded = JSON.parse(readFileSync(metaPath, 'utf-8'))
    seeded.tokenUsage = { prompt: 100_000, completion: 0, total: 100_000 }
    writeFileSync(metaPath, JSON.stringify(seeded))

    await runWorkerSession(config) // 续跑：初始 append 快照 = seed 1,000 < 盘上 100,000
    const after = JSON.parse(readFileSync(metaPath, 'utf-8'))
    assert.equal(after.tokenUsage?.prompt, 100_000, 'listener 快照不得倒扣——否则尾账会被反复吃掉')
  })
})

const isolatedHome = mkdtempSync(join(tmpdir(), 'worker-fixture-home-'))
process.env.RIVET_HOME = isolatedHome
after(() => rmSync(isolatedHome, { recursive: true, force: true }))
