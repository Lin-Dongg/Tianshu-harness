/**
 * 目标对账在 coordinator 上的接线测试。
 *
 * 纯函数的判据在 worker-objective-gate.test.ts 里覆盖；这里只回答一件事：
 * 那道闸门是否真的装在了结果回收路径上——盖的章能不能一路走到主控 packet，
 * 判出的 blocked 会不会被后面的 aggregateResults 抹回 passed。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationCoordinator } from '../coordinator.js'
import type { WorkerSessionRun } from '../worker-session.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  for (const name of ['edit_file', 'write_file', 'bash', 'run_tests']) registry.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

const cards: ModelCapabilityCard[] = [
  {
    model: 'test-model',
    toolUseReliability: 0.8,
    jsonStability: 0.9,
    editSuccessRate: 0.7,
    testRepairRate: 0.7,
    contextWindow: 128_000,
    cacheEconomics: 'medium',
    recommendedTasks: ['code_search'],
  },
]

function createCoordinator(runWorker: () => Promise<WorkerSessionRun>): DelegationCoordinator {
  const config = {
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 2,
    runtimeFactory: () => ({}) as any,
    runWorker,
  }
  return new DelegationCoordinator(config)
}

function workerRun(over: Record<string, unknown> = {}, transcript?: Record<string, unknown>): WorkerSessionRun {
  return {
    session: { getMessages: () => [{ role: 'user', content: 'fixture objective' }, { role: 'assistant', content: 'fixture observations' }] },
    result: {
      workOrderId: 'test',
      status: 'passed' as const,
      summary: '查完了，没发现问题',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified' as const,
      ...over,
    },
    ...(transcript
      ? { transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0, ...transcript } }
      : {}),
  } as unknown as WorkerSessionRun
}

function req(objective: string, extra: Record<string, unknown> = {}) {
  return {
    parentTurnId: 'p-1',
    objective,
    kind: 'code_search' as const,
    profile: 'code_scout' as const,
    scope: { files: ['src/target.ts'] },
    ...extra,
  }
}

function sole(run: { results: WorkerResult[] }): WorkerResult {
  assert.equal(run.results.length, 1, '单发派发应当只回一条结果')
  return run.results[0]!
}

describe('coordinator: 目标对账接线', () => {
  it('派发目标被盖到结果上并带进 packet', async () => {
    const coordinator = createCoordinator(async () => workerRun({ examinedFiles: ['src/target.ts'] }))
    const run = await coordinator.delegate(req('定位 /tasks 面板的渲染函数') as any)

    assert.equal(sole(run).objective, '定位 /tasks 面板的渲染函数', '结果上要有派发侧盖的章')
    assert.ok(run.packet.includes('定位 /tasks 面板的渲染函数'), '主控 packet 里要能看到派它去做什么')
  })

  it('worker 报 passed 却交回空壳 → 主控收到的是 blocked', async () => {
    const coordinator = createCoordinator(async () => workerRun({
      summary: '(no summary provided by worker)',
    }))
    const run = await coordinator.delegate(req('审查 request-freezer 的字节稳定性') as any)

    assert.equal(sole(run).status, 'blocked', 'aggregateResults 不该把对账判出的 blocked 抹回去')
    assert.equal(coordinator.getState().getEvents().filter(e => ['passed', 'failed', 'blocked'].includes(e.type)).at(-1)?.type, 'blocked')
    assert.match(sole(run).risks.join('\n'), /空壳/)
  })

  it('verify 工没跑任何验证 → 主控收到的是 blocked', async () => {
    const coordinator = createCoordinator(async () => workerRun(
      { summary: '看着没问题' },
      { toolUses: ['read_file'] },
    ))
    const run = await coordinator.delegate(req('确认 rewind 回归测试全绿', { kind: 'verify' }) as any)

    assert.equal(sole(run).status, 'blocked')
    assert.match(sole(run).risks.join('\n'), /未执行受派的验证/)
  })

  it('正常交付不受影响', async () => {
    const coordinator = createCoordinator(async () => workerRun({
      summary: 'renderTasksPanel 在 src/tui/format/worker-fleet.ts',
      findings: [{ claim: 'renderTasksPanel 是入口', evidence: 'src/tui/format/worker-fleet.ts:42', confidence: 'high' }],
      examinedFiles: ['src/target.ts'],
    }))
    const run = await coordinator.delegate(req('定位 /tasks 面板的渲染函数') as any)

    assert.equal(sole(run).status, 'passed')
    assert.deepEqual(sole(run).risks, [], '合格交付不该被加噪音')
  })
})
