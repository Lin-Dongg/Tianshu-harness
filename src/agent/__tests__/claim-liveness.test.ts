import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateClaimTakeover, FILE_CLAIM_STALE_MS } from '../claim-liveness.js'
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
  it('L0 幽灵认领（claims 行在、sessions 行无）→ reap', () => {
    const d = evaluateClaimTakeover({
      liveness: live({ ownerPid: null, ownerAlive: false }),
      fileClean: true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'reap')
    assert.equal(d.level, 'L0')
  })

  it('L1 持有方进程已死 → 自动接管（与文件干净态无关）', () => {
    const d = evaluateClaimTakeover({
      liveness: live({ ownerPid: 99999, ownerAlive: false }),
      fileClean: false,
      nowMs: NOW,
    })
    assert.equal(d.action, 'take')
    assert.equal(d.level, 'L1')
  })

  it('L2 独占 ∧ 陈旧 ∧ 工作区干净 → 自动接管（动机案例：5h 未触碰的活会话）', () => {
    const d = evaluateClaimTakeover({ liveness: live(), fileClean: true, nowMs: NOW })
    assert.equal(d.action, 'take')
    assert.equal(d.level, 'L2')
    assert.match(d.reason, /分钟|小时/, 'reason 应含人可读的陈旧时长，供 tool_result 告知')
  })

  it('L3 独占 ∧ 陈旧 ∧ 工作区脏 → 问（不自动夺走未提交改动）', () => {
    const d = evaluateClaimTakeover({ liveness: live(), fileClean: false, nowMs: NOW })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L3')
  })

  it('L3 工作区干净态 unknown → 问（证据不足保守）', () => {
    const d = evaluateClaimTakeover({ liveness: live(), fileClean: 'unknown', nowMs: NOW })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L3')
  })

  it('L4 刚触碰过（新鲜）→ 问（真并发，不自动抢）', () => {
    const d = evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: new Date(NOW - 10_000).toISOString() }),
      fileClean: true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L4')
  })

  it('L2/L4 边界：恰好 staleMs 归接管，差 1ms 归问', () => {
    const atThreshold = evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: new Date(NOW - FILE_CLAIM_STALE_MS).toISOString() }),
      fileClean: true,
      nowMs: NOW,
    })
    assert.equal(atThreshold.action, 'take')
    const justFresh = evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: new Date(NOW - FILE_CLAIM_STALE_MS + 1).toISOString() }),
      fileClean: true,
      nowMs: NOW,
    })
    assert.equal(justFresh.action, 'ask')
  })

  it('shared_read 持有者 → 一律问（不经写路径刷新，租约凭据无意义）', () => {
    const d = evaluateClaimTakeover({
      liveness: live({ claimType: 'shared_read' }),
      fileClean: true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'ask')
    assert.equal(d.level, 'L4')
  })

  it('lastTouchedAt 不可解析 → 问（缺证据不得当陈旧）', () => {
    const d = evaluateClaimTakeover({
      liveness: live({ lastTouchedAt: 'not-a-date' }),
      fileClean: true,
      nowMs: NOW,
    })
    assert.equal(d.action, 'ask')
  })
})
