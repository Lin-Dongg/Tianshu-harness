/**
 * headless 工具装配回归（收编公开仓 PR #362）。
 *
 * main.ts 用暂存 registry 收集 MCP。createDefaultToolRegistry 先注册全部内建，
 * initializeMcp 只追加 mcp__ 工具，getAll() 因此含内建全集。若不减掉，createAgent
 * 会把它们再注册一遍：web_fetch / web_search 因配置成为新实例，触发 ToolRegistry
 * 的「同名覆盖」检测（防 MCP 描述 rug-pull），每次 headless 启动误报。
 *
 * pluginTools 与 plugin-session-cache.ts 已按 builtinNames 减掉内建；mcpTools 曾漏。
 * main.ts 是进程入口，接线用源码守卫；行为由 excludeBuiltinTools 单测覆盖。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolRegistry } from '../registry.js'
import type { Tool } from '../types.js'
import { excludeBuiltinTools } from '../default-registry.js'

function readRepoFile(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
}

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: name, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} ok` }),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

describe('excludeBuiltinTools：从暂存 registry 提取「新增」工具时减掉内建', () => {
  it('只保留不在 builtinNames 里的工具（MCP/插件新增）', () => {
    const stage = new ToolRegistry()
    stage.register(fakeTool('read_file'))
    stage.register(fakeTool('web_fetch'))
    stage.register(fakeTool('mcp__github__list'))

    const builtinNames = new Set(['read_file', 'web_fetch'])
    const added = excludeBuiltinTools(stage.getAll(), builtinNames)

    assert.deepEqual(
      added.map(t => t.definition.name),
      ['mcp__github__list'],
    )
  })

  it('内建全集与暂存表完全重合时结果为空（无 MCP 配置的真实场景）', () => {
    const stage = new ToolRegistry()
    stage.register(fakeTool('read_file'))
    stage.register(fakeTool('web_fetch'))
    stage.register(fakeTool('web_search'))
    const builtinNames = new Set(['read_file', 'web_fetch', 'web_search'])

    assert.equal(excludeBuiltinTools(stage.getAll(), builtinNames).length, 0)
  })

  it('不改动传入数组（纯函数）', () => {
    const stage = new ToolRegistry()
    stage.register(fakeTool('read_file'))
    stage.register(fakeTool('mcp__x__y'))
    const all = stage.getAll()
    const before = all.length
    excludeBuiltinTools(all, new Set(['read_file']))
    assert.equal(all.length, before, '入参数组不应被就地修改')
  })

  it('builtinNames 为空集时全量保留（不误杀）', () => {
    const stage = new ToolRegistry()
    stage.register(fakeTool('read_file'))
    stage.register(fakeTool('web_fetch'))
    assert.equal(excludeBuiltinTools(stage.getAll(), new Set()).length, 2)
  })
})

describe('headless 工具装配接线守卫（src/main.ts）', () => {
  const source = readRepoFile(join('src', 'main.ts')).replace(/\r/g, '')

  it('mcpTools 提取时必须用 builtinNames 减掉内建（与 pluginTools 同形）', () => {
    const usesHelper = /const\s+mcpTools\s*=\s*excludeBuiltinTools\(\s*mcpStageRegistry\.getAll\(\)\s*,\s*builtinNames\s*\)/.test(source)
    const usesInlineFilter = /const\s+mcpTools\s*=\s*mcpStageRegistry\.getAll\(\)\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*!builtinNames\.has\(/.test(source)
    assert.ok(
      usesHelper || usesInlineFilter,
      'mcpTools 必须用 builtinNames 减掉内建；空 Set 或裸 getAll() 都会让 headless 误报「工具注册覆盖」',
    )
  })

  it('不得回到裸 getAll()（历史缺陷形态）', () => {
    const naked = /^\s*const\s+mcpTools\s*=\s*mcpStageRegistry\.getAll\(\)\s*(?:\/\/|$)/m
    assert.equal(naked.test(source), false, 'mcpTools = mcpStageRegistry.getAll() 是本缺陷的原始形态，禁止回归')
  })
})
