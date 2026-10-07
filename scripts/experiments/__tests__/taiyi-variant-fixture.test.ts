import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STAR_DOMAINS } from '../../../src/agent/star-domain-data.js'
import { taiyiVariantDomain, variantMarker, TAIYI_VOLATILE_CONDENSED } from '../taiyi-variants.js'

/**
 * 太一提示词变体 fixture 的护栏。
 *
 * 为什么需要：变体是「实验脚本自建域 def、绕过 star-domain-data.ts」注入的——
 * 生产提示词/守护测试不受影响，代价是没有东西盯着 fixture 本身。
 * 这里盯三件会静默出错的事：A 不再等于生产太一、C 被误改成 A、指纹串发生碰撞
 * （实验的「注入生效」核验会因指纹假阳性而说谎）。
 */
describe('taiyi-variants（对照实验 fixture）', () => {
  it('A 变体的 volatileBlock 逐字等于生产太一（否则基线被偷换）', () => {
    const a = taiyiVariantDomain('A')
    assert.equal(a.volatileBlock, STAR_DOMAINS.taiyi.volatileBlock)
  })

  it('A/C 共享 id/name/motto/courageThreshold，只有 volatileBlock 变', () => {
    const a = taiyiVariantDomain('A')
    const c = taiyiVariantDomain('C')
    assert.equal(a.id, c.id)
    assert.equal(a.name, c.name)
    assert.equal(a.motto, c.motto)
    assert.equal(a.courageThreshold, c.courageThreshold)
    assert.notEqual(a.volatileBlock, c.volatileBlock)
  })

  it('C 变体等于精简文本且严格短于 A', () => {
    const a = taiyiVariantDomain('A')
    const c = taiyiVariantDomain('C')
    assert.equal(c.volatileBlock, TAIYI_VOLATILE_CONDENSED)
    assert.ok(c.volatileBlock.length < a.volatileBlock.length, `C(${c.volatileBlock.length}) 应短于 A(${a.volatileBlock.length})`)
  })

  it('变体指纹互斥——各自只在对应变体块里出现（防 motto 假阳性）', () => {
    const aBlock = taiyiVariantDomain('A').volatileBlock
    const cBlock = taiyiVariantDomain('C').volatileBlock
    const aMark = variantMarker('A')
    const cMark = variantMarker('C')
    assert.ok(aBlock.includes(aMark), `A 指纹「${aMark}」须在 A 块`)
    assert.ok(!cBlock.includes(aMark), `A 指纹「${aMark}」不得出现在 C 块（指纹必须能证伪）`)
    assert.ok(cBlock.includes(cMark), `C 指纹「${cMark}」须在 C 块`)
    assert.ok(!aBlock.includes(cMark), `C 指纹「${cMark}」不得出现在 A 块`)
  })
})
