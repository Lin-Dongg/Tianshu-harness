import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateClaimTakeover, FILE_CLAIM_STALE_MS, readClaimConflict } from '../claim-liveness.js'
import type { ClaimLiveness } from '../session-registry.js'

const NOW = Date.parse('2026-10-07T08:00:00.000Z')

/** 默认：存活独占持有方，30×阈值（≈5h）前触碰过 —— 动机案例形状。 */
function live(over: Partial<ClaimLiveness> = {}): ClaimLiveness {
  const stale = new Date(NOW - FILE_CLAIM_STALE_MS * 30).toISOString()
  return {
    ownerSessionId: 'peer-1234abcd',
    ownerPid: process.pid,
    ownerAlive: true,
    claimType: 'exclusive',
    acquiredAt: stale,
    lastTouchedAt: stale,
    ...over,
  }
}

describe('evaluateClaimTakeover（v2 判定表）', () => {
  it('L0 幽灵认领（claims 行在、sessions 行无）→ reap', async () => {
    const d = await evaluateClaimTakeover({
      liveness: live({ ownerPid: null, ownerAlive: false }),
      probeFileClean: async () => true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'reap')
    assert.equal(d.level, 'L0')
  })

  it('L1 持有方进程已死 → 自动接管（判定与干净态无关；注记附脏态，§6）', async () => {
    let probes = 0
    const d = await evaluateClaimTakeover({
      liveness: live({ ownerPid: 99999, ownerAlive: false }),
      probeFileClean: async () => { probes++; return false },
      nowMs: NOW,
    })
    assert.equal(d.action, 'take')
    assert.equal(d.level, 'L1')
    // 设计 §6：接管注记必须点名「对方工作区里还留着什么」
    assert.equal(probes, 1, 'L1 注记需要脏态——死持有方不可能刷新凭据，探测安全')
    assert.match(d.reason, /仍留有未提交改动/)
  })

  it('L1 注记的脏态三分支：干净 / 有改动 / 不可判定', async () => {
    const dead = live({ ownerPid: 99999, ownerAlive: false })
    const clean = await evaluateClaimTakeover({ liveness: dead, probeFileClean: async () => true, nowMs: NOW })
    assert.match(clean.reason, /无未提交改动/)
    const dirty = await evaluateClaimTakeover({ liveness: dead, probeFileClean: async () => false, nowMs: NOW })
    assert.match(dirty.reason, /仍留有未提交改动/)
    const unknown = await evaluateClaimTakeover({ liveness: dead, probeFileClean: async () => 'unknown' as const, nowMs: NOW })
    assert.match(unknown.reason, /脏态不可判定/)
    // 三分支都只是注记差异，判定恒为 take（与干净态无关）
    assert.equal(unknown.action, 'take')
  })

  it('L2 独占 ∧ 陈旧 ∧ 工作区干净 → 自动接管（动机案例：5h 未触碰的活会话）', async () => {
    const d = await evaluateClaimTakeover({ liveness: live(), probeFileClean: async () => true, nowMs: NOW })
    assert.equal(d.action, 'take')
    assert.equal(d.level, 'L2')
    assert.match(d.reason, /分钟|小时/, 'reason 应含人可读的陈旧时长，供 tool_result 告知')
  })

  it('L3 独占 ∧ 陈旧 ∧ 工作区脏 → 问（不自动夺走未提交改动）', async () => {
    const d = await evaluateClaimTakeover({ liveness: live(), probeFileClean: async () => false, nowMs: NOW })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L3')
  })

  it('L3 工作区干净态 unknown → 问（证据不足保守；reason 不得谎称有改动）', async () => {
    const d = await evaluateClaimTakeover({ liveness: live(), probeFileClean: async () => 'unknown' as const, nowMs: NOW })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L3')
    assert.match(d.reason, /不可判定/, '脏态未知时审批卡要如实渲染「缺证据」')
    assert.doesNotMatch(d.reason, /仍有未提交改动/)
  })

  it('L4 刚触碰过（新鲜）→ 问（真并发，不自动抢）', async () => {
    const d = await evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: new Date(NOW - 10_000).toISOString() }),
      probeFileClean: async () => true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L4')
  })

  it('L2/L4 边界：恰好 staleMs 归接管，差 1ms 归问', async () => {
    const atThreshold = await evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: new Date(NOW - FILE_CLAIM_STALE_MS).toISOString() }),
      probeFileClean: async () => true,
      nowMs: NOW,
    })
    assert.equal(atThreshold.action, 'take')
    const justFresh = await evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: new Date(NOW - FILE_CLAIM_STALE_MS + 1).toISOString() }),
      probeFileClean: async () => true,
      nowMs: NOW,
    })
    assert.equal(justFresh.action, 'ask')
  })

  it('shared_read 持有者 → 一律问（不经写路径刷新，租约凭据无意义）', async () => {
    const d = await evaluateClaimTakeover({
      liveness: live({ claimType: 'shared_read' }),
      probeFileClean: async () => true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L4')
  })

  it('lastTouchedAt 不可解析 → 问（缺证据不得当陈旧）', async () => {
    const d = await evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: 'not-a-date' }),
      probeFileClean: async () => true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'ask')
  })

  // 探针惰性化（2026-10-08 审查 P2）：L0 回收与 L4「问」不需要脏态——探针背后是
  // spawn git status（挂起时最坏 10s+3s），这些分支一次都不许调用。
  it('L0/L4 分支永不触发脏态探针（探针惰性化）', async () => {
    let probes = 0
    const countingProbe = async (): Promise<boolean | 'unknown'> => { probes++; return true }
    const cases: Array<[string, ClaimLiveness]> = [
      ['L0 幽灵', live({ ownerPid: null, ownerAlive: false })],
      ['L4 新鲜', live({ lastTouchedAt: new Date(NOW - 10_000).toISOString() })],
      ['L4 shared_read', live({ claimType: 'shared_read' })],
      ['L4 时间不可解析', live({ lastTouchedAt: 'not-a-date' })],
    ]
    for (const [name, liveness] of cases) {
      const before = probes
      await evaluateClaimTakeover({ liveness, probeFileClean: countingProbe, nowMs: NOW })
      assert.equal(probes, before, `${name} 分支不得触发脏态探针`)
    }
  })
})

describe('readClaimConflict（审批载荷守卫）', () => {
  it('parses a full payload and passes optional fields through', () => {
    const info = readClaimConflict({
      file_path: 'foo.ts',
      __claimConflict: {
        filePath: 'foo.ts', ownerSessionId: 'peer-1234abcd', ownerAlive: false,
        lastTouchedAt: '2026-10-08T00:00:00.000Z', reason: '对方（会话 peer-123）已 3 小时未触碰该文件',
      },
    })
    assert.deepEqual(info, {
      filePath: 'foo.ts', ownerSessionId: 'peer-1234abcd', ownerAlive: false,
      lastTouchedAt: '2026-10-08T00:00:00.000Z', reason: '对方（会话 peer-123）已 3 小时未触碰该文件',
    })
  })

  it('degrades to null on absent or malformed markers (消费方回退普通审批措辞)', () => {
    assert.equal(readClaimConflict({}), null)
    assert.equal(readClaimConflict({ __claimConflict: 'garbage' }), null)
    assert.equal(readClaimConflict({ __claimConflict: ['foo.ts'] }), null)
    assert.equal(readClaimConflict({ __claimConflict: { filePath: 1, ownerSessionId: 'x' } }), null)
    assert.equal(readClaimConflict({ __claimConflict: { ownerSessionId: 'x' } }), null)
  })

  it('keeps only well-typed optional fields', () => {
    const info = readClaimConflict({
      __claimConflict: { filePath: 'foo.ts', ownerSessionId: 'peer', ownerAlive: 'yes', reason: 42 },
    })
    assert.deepEqual(info, { filePath: 'foo.ts', ownerSessionId: 'peer' })
  })
})
