/**
 * headless 工具装配回归（发现于 dogfood，2026-10-06）
 *
 * 背景：`src/main.ts` 的 headless 路径用两个「暂存 registry」收集插件与 MCP 工具，
 * 再并入真正的 toolRegistry：
 *
 *   const pluginRegistry = createDefaultToolRegistry([], registryOptions)   // ← 含内建全集
 *   ...
 *   const builtinNames = new Set(createDefaultToolRegistry([], registryOptions).getAllNames())
 *   const pluginTools = pluginRegistry.getAll().filter(t => !builtinNames.has(t.definition.name))  // ✅ 减掉内建
 *
 *   const mcpStageRegistry = createDefaultToolRegistry([], registryOptions)  // ← 同样含内建全集
 *   await initializeMcp(cfg, mcpStageRegistry, mcpRefs)
 *   const mcpTools = mcpStageRegistry.getAll()                              // ❌ 未减内建
 *
 * `initializeMcp` 只在传入 registry 上【追加】`mcp__` 工具、不清空，所以 `getAll()`
 * 必然返回「内建全集 + MCP」。这些内建工具随后在 createAgent 里被整体重注册进真正的
 * toolRegistry（`main.ts` 的 `for (const tool of mcpTools) toolRegistry.register(tool)`）。
 *
 * 危害：内建 `web_fetch` / `web_search` 因带 config（fetchOptions / searchBackends）由
 * 工厂函数生成【新实例】，`existing !== tool` 成立，触发 `ToolRegistry` 的「同名覆盖」
 * 检测——而该检测是防 MCP 工具描述 rug-pull 的安全钩子。于是每次 headless 运行都在
 * stderr 打出两条「工具注册覆盖」告警（实测 3.28.0：2 条），把安全钩子的信噪比打光。
 *
 * 同目录 `plugin-session-cache.ts:53` 与 `main.ts` 的 pluginTools 都正确减掉了内建；
 * 唯独 mcpTools 这一处漏了 —— 本测试钉住该不变式，防再次复现。
 *
 * 注意（测试形态选择）：`src/main.ts` 无可导入导出（进程入口），故采用仓库既有的
 * 源码守卫模式（见 `src/cli/__tests__/launcher-contract.test.ts` 对 main.ts 的断言），
 * 断言的是【接线】而非运行时；行为层由 `excludeBuiltinTools` 单测覆盖。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
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
    stage.register(fakeTool('read_file'))         // 内建
    stage.register(fakeTool('web_fetch'))         // 内建（带 config 时为新实例）
    stage.register(fakeTool('mcp__github__list')) // MCP 新增

    const builtinNames = new Set(['read_file', 'web_fetch'])
    const added = excludeBuiltinTools(stage.getAll(), builtinNames)

    assert.deepEqual(
      added.map(t => t.definition.name),
      ['mcp__github__list'],
      '内建工具必须被减掉；只有 MCP/插件新增的工具能进结果',
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
  const source = readRepoFile(join('src', 'main.ts'))

  it('mcpTools 提取时必须减掉内建工具名（与 pluginTools 同形）', () => {
    // 允许两种等价写法：内联 filter，或经 excludeBuiltinTools 帮助函数。
    const usesHelper = /const\s+mcpTools\s*=\s*excludeBuiltinTools\(/.test(source)
    const usesInlineFilter =
      /const\s+mcpTools\s*=\s*mcpStageRegistry\.getAll\(\)\.filter\(/.test(source)
    assert.ok(
      usesHelper || usesInlineFilter,
      'mcpTools 必须减掉内建工具（否则 headless 会把内建工具当 MCP 工具重注册，触发安全告警误报）',
    )
  })

  it('不得回到裸 getAll()（历史缺陷形态）', () => {
    // 反证：把裸形态写回来，本断言必须失败（改动前已验证确实变红）。
    // 早期版本用 /…getAll\(\)\s*$/（无 m flag）——`$` 只锚定整个输入末尾，而目标行
    // 位于文件中段，断言恒真、零保护力；这里显式 m flag 锚定行尾，并容忍行尾注释
    // （历史缺陷形态常带注释）。
    const naked = /^\s*const\s+mcpTools\s*=\s*mcpStageRegistry\.getAll\(\)\s*(?:\/\/|$)/m
    assert.ok(
      !naked.test(source.replace(/\r/g, '')),
      'mcpTools = mcpStageRegistry.getAll() 是本缺陷的原始形态，禁止回归',
    )
  })
})

void sep
