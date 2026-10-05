import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ToolRegistry,
  classifyToolOverwrite,
  __resetOverwriteLog,
  __setOverwriteSink,
} from '../registry.js'
import type { Tool, ToolCallParams } from '../types.js'

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

describe('ToolRegistry.execute', () => {
  it('runs a registered tool and returns its result', async () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('read_file'))

    const result = await registry.execute('read_file', {
      input: {},
      toolUseId: 'tu-1',
      cwd: process.cwd(),
    })
    assert.equal(result.content, 'read_file executed')
  })

  it('throws "Tool disabled" when a registered tool is disabled', async () => {
    const registry = new ToolRegistry()
    const disabled: Tool = { ...fakeTool('read_file'), isEnabled: () => false }
    registry.register(disabled)

    await assert.rejects(
      () => registry.execute('read_file', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      /Tool read_file is disabled/,
    )
  })
})

describe('ToolRegistry.execute: unknown tool surfaces did-you-mean hint', () => {
  // Session 6176a17f reproduction: model called `task` (Cursor/Claude Code
  // convention) instead of `delegate_task`. The fix is to surface actionable
  // feedback in the error message so the next model turn can self-correct.

  function makeRegistry(): ToolRegistry {
    // onToolOverwrite: no-op —— 夹具内有意覆盖（TodoWrite/disabled 用例用新实例
    // 替换同名工具），不是被测行为；默认通道的告警语义在「同名覆盖检测」块单独测。
    const registry = new ToolRegistry({ onToolOverwrite: () => {} })
    registry.register(fakeTool('read_file'))
    registry.register(fakeTool('write_file'))
    registry.register(fakeTool('edit_file'))
    registry.register(fakeTool('grep'))
    registry.register(fakeTool('delegate_task'))
    registry.register(fakeTool('delegate_batch'))
    return registry
  }

  it('transparently maps `task` → delegate_task (foreign alias, not error)', async () => {
    const registry = makeRegistry()

    // `task` is a Cursor/Claude Code convention. It should transparently
    // map to delegate_task — no error, no wasted turn.
    const result = await registry.execute('task', {
      input: { objective: 'test' },
      toolUseId: 'tu-1',
      cwd: process.cwd(),
    })
    assert.ok(result.content.includes('[NOTE: "task" 自动映射为 "delegate_task"'))
    assert.ok(result.content.includes('delegate_task executed'))
  })

  it('transparently maps `TodoWrite` → todo (foreign alias, case-insensitive)', async () => {
    const registry = makeRegistry()
    const todoTool = fakeTool('todo')
    // Overwrite the earlier fakeTool('todo') with one that returns a recognizable result
    registry.register(todoTool)

    const result = await registry.execute('TodoWrite', {
      input: { action: 'read' },
      toolUseId: 'tu-1',
      cwd: process.cwd(),
    })
    assert.ok(result.content.includes('[NOTE: "TodoWrite" 自动映射为 "todo"'))
    assert.ok(result.content.includes('todo executed'))
  })

  it('transparently maps `Agent` → delegate_task (foreign alias)', async () => {
    const registry = makeRegistry()

    const result = await registry.execute('Agent', {
      input: { objective: 'test' },
      toolUseId: 'tu-1',
      cwd: process.cwd(),
    })
    assert.ok(result.content.includes('[NOTE: "Agent" 自动映射为 "delegate_task"'))
    assert.ok(result.content.includes('delegate_task executed'))
  })

  it('alias resolution still checks isEnabled before executing', async () => {
    const registry = makeRegistry()
    // Disable delegate_task — `task` alias should throw
    const disabled: Tool = {
      ...fakeTool('delegate_task'),
      isEnabled: () => false,
    }
    registry.register(disabled)

    await assert.rejects(
      () => registry.execute('task', {
        input: { objective: 'test' },
        toolUseId: 'tu-1',
        cwd: process.cwd(),
      }),
      /Tool delegate_task is disabled/,
    )
  })

  // resolveName lets the tool pipeline canonicalize BEFORE its permission
  // gates — otherwise a deny rule on delegate_task could be bypassed by
  // calling the `task` alias (remapping used to happen only inside execute).
  it('resolveName canonicalizes foreign aliases for pre-gate use', () => {
    const registry = makeRegistry()
    assert.equal(registry.resolveName('task'), 'delegate_task')
    assert.equal(registry.resolveName('Agent'), 'delegate_task')
    assert.equal(registry.resolveName('read_file'), 'read_file')
    assert.equal(registry.resolveName('no_such_tool'), 'no_such_tool')
  })

  it('resolveName does not remap when the alias target is unregistered', () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('read_file'))
    assert.equal(registry.resolveName('task'), 'task')
  })

  it('surfaces the typo "delegte_task" → delegate_task (Levenshtein)', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('delegte_task', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Unknown tool: delegte_task/)
        assert.match(err.message, /Did you mean: delegate_task/)
        return true
      },
    )
  })

  it('surfaces sibling-tool typo "reed_file" → read_file', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('reed_file', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Did you mean: read_file/)
        return true
      },
    )
  })

  it('still includes "Available tools" when no near-match exists', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('xyzpdq', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Unknown tool: xyzpdq/)
        assert.match(err.message, /Available tools:/)
        assert.match(err.message, /delegate_task/)
        assert.match(err.message, /read_file/)
        return true
      },
    )
  })

  it('omits "Did you mean" when no near-match exists', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('xyzpdq', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /Did you mean/)
        return true
      },
    )
  })

  it('catalog is sorted for stable prefix-cache behavior', async () => {
    // Tools listed in `Available tools:` should be sorted alphabetically so
    // the same unknown name across sessions produces the same error message
    // (DeepSeek exact-prefix cache stability).
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('xyzpdq', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        const toolsSection = err.message.split('Available tools: ')[1] ?? ''
        const names = toolsSection.split(', ')
        const sorted = names.slice().sort()
        assert.deepEqual(names, sorted, 'Available tools must be alphabetically sorted')
        return true
      },
    )
  })

  it('error name remains "Error" (catch handlers downstream key on this)', async () => {
    // tool-pipeline.ts:1027 reads err.message — but downstream logging or
    // metrics may also key on err.name. Keep the class default so existing
    // catch sites that do `err instanceof Error` continue to work.
    const registry = new ToolRegistry()

    let caught: unknown
    try {
      await registry.execute('absent', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() })
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof Error)
    assert.equal((caught as Error).name, 'Error')
  })
})

describe('ToolRegistry.getAllNames', () => {
  it('returns sorted names for deterministic did-you-mean hints', () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('write_file'))
    registry.register(fakeTool('read_file'))
    registry.register(fakeTool('grep'))

    assert.deepEqual(registry.getAllNames(), ['grep', 'read_file', 'write_file'])
  })
})

// ── 晚到注册就绪闸门（回流自 3.14alpha 71872ed9f，缓存碎裂根修）──────────────
describe('ToolRegistry 晚到注册闸门', () => {
  it('pending=0 时 await 立即返回（常态零开销）', async () => {
    const r = new ToolRegistry()
    const t0 = Date.now()
    await r.awaitExtraRegistrations(5_000)
    assert.ok(Date.now() - t0 < 50, '清零态应直通')
  })

  it('begin 后 await 阻塞，end 清零时释放全部等待者', async () => {
    const r = new ToolRegistry()
    r.beginExtraRegistration()
    r.beginExtraRegistration()
    let released1 = false
    let released2 = false
    void r.awaitExtraRegistrations(5_000).then(() => { released1 = true })
    void r.awaitExtraRegistrations(5_000).then(() => { released2 = true })
    await new Promise(res => setTimeout(res, 30))
    assert.ok(!released1 && !released2, 'pending 未清零不应放行')
    r.endExtraRegistration()
    await new Promise(res => setTimeout(res, 10))
    assert.ok(!released1, '仍剩 1 个注册未完成')
    r.endExtraRegistration()
    await new Promise(res => setTimeout(res, 10))
    assert.ok(released1 && released2, '清零后全部等待者释放')
  })

  it('超时放行：挂死的注册不永久阻塞会话', async () => {
    const r = new ToolRegistry()
    r.beginExtraRegistration()
    const t0 = Date.now()
    await r.awaitExtraRegistrations(80)
    assert.ok(Date.now() - t0 >= 70, '应等到超时才放行')
    r.endExtraRegistration()
    // 超时后再来一个 await：已清零，直通
    await r.awaitExtraRegistrations(5_000)
  })

  it('end 在 0 基线上不透底（幂等防御）', () => {
    const r = new ToolRegistry()
    r.endExtraRegistration()
    r.endExtraRegistration()
    // 不抛错即通过；内部计数已钳制为 0
  })
})

// ── 同名覆盖检测（rug pull 防线 ④：后到者赢 → 至少可观察）────────────────
// 背景：安全报告《MCP 工具描述 rug pull》——ToolRegistry.register 为裸 Map.set，
// 同名覆盖（后到者赢）无任何告警。本块锁定：已知刷新源（mcp__/lsp_ 前缀）静默、
// 其余覆盖经可注入 reporter 上报、默认通道进程级去重、覆盖行为本身不变。
describe('ToolRegistry 同名覆盖检测', () => {
  it('classifyToolOverwrite：mcp__/lsp_ 前缀为已知刷新，其余为意外覆盖', () => {
    assert.equal(classifyToolOverwrite('mcp__web__search'), 'known-refresh')
    assert.equal(classifyToolOverwrite('lsp_goto_definition'), 'known-refresh')
    assert.equal(classifyToolOverwrite('lsp_find_references'), 'known-refresh')
    assert.equal(classifyToolOverwrite('read_file'), 'unexpected')
    assert.equal(classifyToolOverwrite('plugin_export'), 'unexpected')
  })

  it('意外同名覆盖（新实例）触发注入 reporter', () => {
    const seen: string[] = []
    const r = new ToolRegistry({ onToolOverwrite: (n) => seen.push(n) })
    r.register(fakeTool('custom_tool'))
    r.register(fakeTool('custom_tool'))
    assert.deepEqual(seen, ['custom_tool'])
  })

  it('已知刷新前缀（mcp__/lsp_）静默——不触发 reporter', () => {
    const seen: string[] = []
    const r = new ToolRegistry({ onToolOverwrite: (n) => seen.push(n) })
    r.register(fakeTool('mcp__web__search'))
    r.register(fakeTool('mcp__web__search'))
    r.register(fakeTool('lsp_goto_definition'))
    r.register(fakeTool('lsp_goto_definition'))
    assert.deepEqual(seen, [])
  })

  it('同一对象重复注册（幂等路径）不触发上报', () => {
    const seen: string[] = []
    const r = new ToolRegistry({ onToolOverwrite: (n) => seen.push(n) })
    const t = fakeTool('read_file')
    r.register(t)
    r.register(t)
    assert.deepEqual(seen, [])
  })

  it('默认通道进程级一次/名字（去重），且覆盖行为保持后到者赢', async () => {
    __resetOverwriteLog()
    const lines: string[] = []
    __setOverwriteSink((m) => lines.push(m))
    try {
      const r = new ToolRegistry()
      r.register(fakeTool('squat_tool'))
      const second: Tool = {
        ...fakeTool('squat_tool'),
        execute: async () => ({ content: 'second wins' }),
      }
      r.register(second)

      const res = await r.execute('squat_tool', { input: {}, toolUseId: 't', cwd: '/' })
      assert.equal(res.content, 'second wins', '行为不变：后到者赢')

      r.register(fakeTool('squat_tool'))
      assert.equal(lines.length, 1, '同名多次覆盖去重为一次')
      assert.match(lines[0]!, /squat_tool/)
    } finally {
      __resetOverwriteLog()
      __setOverwriteSink(null)
    }
  })

  it('覆盖后 get 拿到的是新实例（不静默丢弃）', () => {
    const r = new ToolRegistry({ onToolOverwrite: () => {} })
    const first = fakeTool('x_tool')
    const second = fakeTool('x_tool')
    r.register(first)
    r.register(second)
    assert.equal(r.get('x_tool'), second)
  })
})