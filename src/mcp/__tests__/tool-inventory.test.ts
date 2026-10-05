import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeInventory,
  diffInventory,
  evaluateInventoryGate,
  armInventoryApproval,
  readInventoryStore,
  formatInventoryNotice,
  __resetInventoryWarnings,
  __setInventoryWarnSink,
} from '../tool-inventory.js'

/** rug pull 防线 ① 基底：工具清单快照门。
 *  语义（与 #215 对齐）：交互宿主（gate）清单变更 → block 待重新审批；
 *  fail-open 宿主 → 放行 + 变更标记（不写 accepted，信号持续可见）；
 *  armed hash（用户显式批准的那版）精确匹配才消费放行（防 TOCTOU 二次换毒）。 */

const tool = (name: string, description?: string, properties: Record<string, unknown> = {}) => ({
  name,
  description,
  inputSchema: { type: 'object' as const, properties },
})

function withHome(fn: () => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'rivet-inv-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  __resetInventoryWarnings()
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })
}

describe('tool-inventory', () => {
  it('computeInventory：列表顺序无关、属性键序无关、单字符/结构变更敏感', () => {
    const a = computeInventory('s', [
      tool('x', 'A', { p: { type: 'string', description: 'd' } }),
      tool('y', 'B'),
    ])
    const b = computeInventory('s', [
      tool('y', 'B'),
      tool('x', 'A', { p: { description: 'd', type: 'string' } }),
    ])
    assert.equal(a.hash, b.hash, '顺序/键序不同不算变更')

    const c = computeInventory('s', [tool('x', 'A!'), tool('y', 'B')])
    assert.notEqual(a.hash, c.hash, '描述单字符变更必须敏感')

    const d = computeInventory('s', [
      tool('x', 'A', { p: { type: 'string', description: 'd2' } }),
      tool('y', 'B'),
    ])
    assert.notEqual(a.hash, d.hash, 'schema 变更必须敏感')

    // entries 按 name 排序（diff 与去重稳定）
    assert.deepEqual(a.entries.map((e) => e.name), ['x', 'y'])
  })

  it('diffInventory 三分类', () => {
    const prev = computeInventory('s', [tool('a', 'A'), tool('b', 'B'), tool('c', 'C')])
    const next = computeInventory('s', [tool('a', 'A'), tool('b', 'B2'), tool('d', 'D')])
    const diff = diffInventory(prev, next)
    assert.deepEqual(diff.added, ['d'])
    assert.deepEqual(diff.removed, ['c'])
    assert.deepEqual(diff.changed, ['b'])
  })

  it('首次连接：写 accepted、放行、无变更标记', async () => {
    await withHome(() => {
      const v = evaluateInventoryGate({
        fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'A')], interactive: true,
      })
      assert.equal(v.action, 'allow')
      assert.equal(v.action === 'allow' ? v.changed : 'n/a', undefined)
      assert.ok(readInventoryStore().accepted['fp1'], '首次连接应落快照')
    })
  })

  it('清单一致：放行、无变更标记', async () => {
    await withHome(() => {
      const tools = [tool('x', 'A')]
      evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools, interactive: true })
      const v = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools, interactive: true })
      assert.equal(v.action, 'allow')
      assert.equal(v.action === 'allow' ? v.changed : 'n/a', undefined)
    })
  })

  it('不一致 + interactive：block（pending 携带 hash/diff/时间，accepted 不动）', async () => {
    await withHome(() => {
      evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'A')], interactive: true })
      const v = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'EVIL')], interactive: true })
      assert.equal(v.action, 'block')
      if (v.action !== 'block') return
      assert.equal(v.pending.reason, 'inventory-change')
      assert.deepEqual(v.pending.inventoryDiff.changed, ['x'])
      assert.ok(v.pending.inventoryHash)
      assert.ok(v.pending.changedAt)
      assert.equal(
        readInventoryStore().accepted['fp1']?.hash,
        computeInventory('s', [tool('x', 'A')]).hash,
        '被拦截的版本不得写入 accepted',
      )
    })
  })

  it('armed 匹配：批准后放行、消费 armed、更新 accepted', async () => {
    await withHome(() => {
      evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'A')], interactive: true })
      const blocked = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'V2')], interactive: true })
      assert.equal(blocked.action, 'block')
      if (blocked.action !== 'block') return

      armInventoryApproval('fp1', blocked.pending.inventoryHash)
      const v = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'V2')], interactive: true })
      assert.equal(v.action, 'allow')
      assert.equal(v.action === 'allow' ? v.changed : 'n/a', undefined, '批准后不标变更')
      const store = readInventoryStore()
      assert.equal(store.armed?.['fp1'], undefined, 'armed 消费即清')
      assert.equal(store.accepted['fp1']?.hash, computeInventory('s', [tool('x', 'V2')]).hash)
    })
  })

  it('TOCTOU：批准 A 版后实拉到 B 版（又变）→ 继续拦截', async () => {
    await withHome(() => {
      evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'A')], interactive: true })
      const b1 = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'V1')], interactive: true })
      assert.equal(b1.action, 'block')
      if (b1.action !== 'block') return

      armInventoryApproval('fp1', b1.pending.inventoryHash)
      const v = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'V3')], interactive: true })
      assert.equal(v.action, 'block', '实拉版本与用户批准版本不符，必须继续拦截')
    })
  })

  it('fail-open（无 UI）：放行 + 变更标记 + accepted 保持旧值（信号持续可见）', async () => {
    await withHome(() => {
      evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'A')], interactive: true })

      const lines: string[] = []
      __setInventoryWarnSink((m) => lines.push(m))
      try {
        const v1 = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'B')], interactive: false })
        assert.equal(v1.action, 'allow')
        assert.deepEqual(v1.action === 'allow' ? v1.changed?.diff.changed : [], ['x'])

        const v2 = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'B')], interactive: false })
        assert.deepEqual(v2.action === 'allow' ? v2.changed?.diff.changed : [], ['x'], '未接受前每次连接都带标记')

        assert.equal(
          readInventoryStore().accepted['fp1']?.hash,
          computeInventory('s', [tool('x', 'A')]).hash,
          'fail-open 不写 accepted——标记持续到被显式接受',
        )
        assert.equal(lines.length, 1, '同一变更版本告警一次（进程级去重）')
        assert.match(lines[0]!, /fp1|s/) // 告警含定位线索（fingerprint 或 serverId）
      } finally {
        __setInventoryWarnSink(null)
      }
    })
  })

  it('坏 store 文件容错：按首次处理（放行 + 重建），不引入全员拒绝', async () => {
    await withHome(() => {
      writeFileSync(join(process.env.RIVET_HOME!, 'mcp-tool-inventory.json'), '{ broken json')
      const v = evaluateInventoryGate({ fingerprint: 'fp1', serverId: 's', tools: [tool('x', 'A')], interactive: true })
      assert.equal(v.action, 'allow')
      assert.ok(readInventoryStore().accepted['fp1'], '坏文件后重建可用')
    })
  })

  it('formatInventoryNotice：数字摘要 + 名单（>5 截断"等"）+ 未经审批声明', () => {
    const prev = computeInventory('s', [tool('a', 'A')])
    const next = computeInventory('s', [
      tool('a', 'A2'), tool('b', 'B'), tool('c', 'C'), tool('d', 'D'), tool('e', 'E'), tool('f', 'F'),
    ])
    const notice = formatInventoryNotice(diffInventory(prev, next), '2026-10-05T14:00:00.000Z')
    assert.match(notice, /新增 5 \/ 移除 0 \/ 修改 1/)
    assert.match(notice, /等/)
    assert.match(notice, /尚未经重新审批/)
    assert.match(notice, /a/) // 变更名单出现（changed 优先）
  })
})
