import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripThinkTags, filterThinkTagDelta, flushThinkTagHold } from '../inline-reasoning.js'

describe('stripThinkTags', () => {
  it('removes a bare closing tag and keeps the surrounding text intact', () => {
    // 线上抓样（2026-10-06 会话 2026100677724c4ca112）：13 处 </think> 全部没有配对
    // 的开标记，且半数出现在 content 的第 0 位。
    assert.equal(stripThinkTags('没问题。</think>这是回答。'), '没问题。这是回答。')
    assert.equal(stripThinkTags('</think>好，这次 grep 返回了。'), '好，这次 grep 返回了。')
  })

  it('removes the opening tag variant too', () => {
    assert.equal(stripThinkTags('<think>算一下</think>答案是 4。'), '算一下答案是 4。')
  })

  it('does NOT touch <thinking> — that marker is constructed by the Anthropic client on the wire', () => {
    const text = '<thinking>\nreasoning\n</thinking>\n\nanswer'
    assert.equal(stripThinkTags(text), text)
  })

  it('is a no-op when no tag is present', () => {
    assert.equal(stripThinkTags('普通回答。'), '普通回答。')
    assert.equal(stripThinkTags(''), '')
  })

  it('tolerates whitespace inside the tag', () => {
    assert.equal(stripThinkTags('a</think >b'), 'ab')
  })
})

describe('filterThinkTagDelta（流式）', () => {
  it('never leaks a tag split across deltas', () => {
    const hold0 = { hold: '' }
    const out: string[] = []
    for (const d of ['我先看', '看文件。', '</thi', 'nk>', '结论是 A。']) {
      const r = filterThinkTagDelta(hold0.hold, d)
      hold0.hold = r.hold
      out.push(r.out)
    }
    out.push(flushThinkTagHold(hold0.hold))
    assert.equal(out.join(''), '我先看看文件。结论是 A。')
    assert.ok(!out.join('').includes('think'), '标签一个字符都不许外发')
  })

  it('holds a trailing "<" that may start a tag, and releases it when it cannot', () => {
    const a = filterThinkTagDelta('', 'a <')
    assert.equal(a.out, 'a ', '不确定的 < 先扣住')
    assert.equal(a.hold, '<')
    const b = filterThinkTagDelta(a.hold, 'b')
    assert.equal(b.out, '<b', '确认不是标签后原样放行')
    assert.equal(b.hold, '')
  })

  it('flushes an unterminated tag prefix without emitting it as text', () => {
    assert.equal(flushThinkTagHold('</thin'), '')
    assert.equal(flushThinkTagHold('正常尾部'), '正常尾部')
  })

  it('passes plain text through unchanged', () => {
    const r = filterThinkTagDelta('', '完全普通的一段文本，没有尖括号。')
    assert.equal(r.out, '完全普通的一段文本，没有尖括号。')
    assert.equal(r.hold, '')
  })
})
