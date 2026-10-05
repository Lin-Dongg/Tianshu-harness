import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanForMatches,
  scanForRange,
  type ScanBudget,
} from '../bounded-scan.js'

/**
 * P0 RED suite — bounded line scanner.
 *
 * The scanner exists to make the grep fallback / anchor / read_file range
 * paths retain memory O(1) w.r.t. the number of lines SCANNED, not O(lines).
 * These tests pin: line numbering, CRLF, split multi-byte decode, over-long
 * lines, maxMatches, context windows (with de-dup), abort, deadline, and that
 * a no-match scan retains nothing while still reporting completeness.
 */
describe('bounded-scan', () => {
  let dir: string
  before(() => { dir = mkdtempSync(join(tmpdir(), 'bounded-scan-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  let seq = 0
  function fixture(content: string): string {
    const p = join(dir, `f${seq++}.txt`)
    writeFileSync(p, content)
    return p
  }

  it('yields matches with 1-based line numbers', async () => {
    const p = fixture(['a', 'MATCH one', 'b', 'c', 'MATCH two'].join('\n') + '\n')
    const res = await scanForMatches(p, l => l.includes('MATCH'))
    assert.deepEqual(res.lines.map(l => [l.lineNumber, l.text, l.isMatch]), [
      [2, 'MATCH one', true],
      [5, 'MATCH two', true],
    ])
    assert.equal(res.matchCount, 2)
    assert.equal(res.complete, true)
    assert.equal(res.stoppedReason, 'eof')
    assert.equal(res.scannedLines, 5)
  })

  it('strips CRLF line endings', async () => {
    const p = fixture('MATCH a\r\nother\r\nMATCH b\r\n')
    const res = await scanForMatches(p, l => l.includes('MATCH'))
    assert.deepEqual(res.lines.map(l => l.text), ['MATCH a', 'MATCH b'])
    assert.equal(res.scannedLines, 3)
  })

  it('handles a final line with no trailing newline', async () => {
    const p = fixture('dup\nMATCH tail')
    const res = await scanForMatches(p, l => l.includes('MATCH'))
    assert.deepEqual(res.lines.map(l => [l.lineNumber, l.text]), [[2, 'MATCH tail']])
    assert.equal(res.complete, true)
  })

  it('decodes multi-byte UTF-8 split across chunk boundaries', async () => {
    // 3 bytes/char: force the chunk boundary to slice a character.
    const p = fixture('中文匹配第一行\n无关行\n中文匹配第三行\n')
    const res = await scanForMatches(p, l => l.includes('匹配'), { budget: { chunkBytes: 4 } })
    assert.deepEqual(res.lines.map(l => [l.lineNumber, l.text]), [
      [1, '中文匹配第一行'],
      [3, '中文匹配第三行'],
    ])
  })

  it('marks over-long lines, does not match them, and keeps scanning', async () => {
    const long = 'x'.repeat(2000) + 'MATCH' + 'y'.repeat(2000)
    const p = fixture(`${long}\nMATCH ok\n`)
    const res = await scanForMatches(p, l => l.includes('MATCH'), { budget: { maxLineChars: 512 } })
    // The over-long line is skipped (a) so memory stays bounded and (b) because
    // matching a truncated prefix would be a false negative/positive.
    assert.deepEqual(res.lines.map(l => [l.lineNumber, l.text]), [[2, 'MATCH ok']])
    assert.equal(res.lineTooLongCount, 1)
    assert.equal(res.complete, false)
    assert.equal(res.stoppedReason, 'lineTooLong')
  })

  it('stops at maxMatches after flushing trailing context', async () => {
    const p = fixture(['L1', 'MATCH A', 'L3', 'L4', 'MATCH B', 'L6', 'L7'].join('\n') + '\n')
    const res = await scanForMatches(p, l => l.includes('MATCH'), { contextLines: 1, maxMatches: 1 })
    assert.deepEqual(res.lines.map(l => [l.lineNumber, l.text, l.isMatch]), [
      [1, 'L1', false],
      [2, 'MATCH A', true],
      [3, 'L3', false],
    ])
    assert.equal(res.matchCount, 1)
    assert.equal(res.stoppedReason, 'maxMatches')
  })

  it('de-duplicates context shared by adjacent matches', async () => {
    const p = fixture(['L1', 'MATCH A', 'L3', 'L4', 'MATCH B', 'L6'].join('\n') + '\n')
    const res = await scanForMatches(p, l => l.includes('MATCH'), { contextLines: 1 })
    // L3 is trailing context of MATCH A and leading context of MATCH B — once.
    assert.deepEqual(res.lines.map(l => [l.lineNumber, l.text, l.isMatch]), [
      [1, 'L1', false],
      [2, 'MATCH A', true],
      [3, 'L3', false],
      [4, 'L4', false],
      [5, 'MATCH B', true],
      [6, 'L6', false],
    ])
  })

  it('stops when the abort signal is already aborted', async () => {
    const p = fixture('one\ntwo\nthree\n')
    const ac = new AbortController()
    ac.abort()
    const res = await scanForMatches(p, () => true, { budget: { signal: ac.signal } })
    assert.equal(res.stoppedReason, 'aborted')
    assert.equal(res.complete, false)
    assert.equal(res.lines.length, 0)
  })

  it('stops when the deadline has passed', async () => {
    const p = fixture(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const res = await scanForMatches(p, () => false, { budget: { deadlineMs: 0 } })
    assert.equal(res.stoppedReason, 'deadline')
    assert.equal(res.complete, false)
  })

  it('retains nothing for a no-match scan of a large file', async () => {
    const n = 50_000
    const p = fixture(Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n')
    const res = await scanForMatches(p, l => l.includes('ABSENT_NEEDLE'))
    assert.equal(res.lines.length, 0)
    assert.equal(res.matchCount, 0)
    assert.equal(res.scannedLines, n)
    assert.equal(res.complete, true)
  })

  it('scanForRange returns the requested window and stops at range end', async () => {
    const p = fixture(Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    const res = await scanForRange(p, 10, 3)
    assert.deepEqual(res.lines.map(l => l.text), ['line 10', 'line 11', 'line 12'])
    assert.equal(res.stoppedReason, 'rangeComplete')
    // Did not read the whole file to learn the total.
    assert.equal(res.totalLines, null)
    assert.ok(res.scannedLines < 1000)
  })

  it('scanForRange reports the true total only when it reached EOF', async () => {
    const p = fixture('a\nb\nc\n')
    const beyond = await scanForRange(p, 10, 5)
    assert.deepEqual(beyond.lines, [])
    assert.equal(beyond.totalLines, 3)
    assert.equal(beyond.complete, true)

    const tail = await scanForRange(p, 2, 100)
    assert.deepEqual(tail.lines.map(l => l.text), ['b', 'c'])
    assert.equal(tail.totalLines, 3)
  })

  it('honours a custom chunk size without changing results', async () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const a = fixture(content)
    const b = fixture(content)
    const big = await scanForRange(a, 1, 200, { chunkBytes: 1024 * 1024 })
    const small = await scanForRange(b, 1, 200, { chunkBytes: 16 })
    assert.deepEqual(small.lines, big.lines)
  })
  it('range results carry the real line number of each returned line', async () => {
    const p = fixture(`a\n${'z'.repeat(2000)}\nc\n`)
    const res = await scanForRange(p, 1, 3, { maxLineChars: 512 })
    assert.deepEqual(
      res.lines.map(l => l.lineNumber),
      [1, 3],
      'a skipped over-long line must not shift later line numbers',
    )
  })

  it('truncate mode clips an over-long line and keeps later lines aligned', async () => {
    const long = 'y'.repeat(2000)
    const p = fixture(`first\n${long}\nthird\n`)
    const res = await scanForRange(p, 1, 3, { maxLineChars: 512, overlongLine: 'truncate' })
    assert.equal(res.lines.length, 3)
    assert.equal(res.lines[0]!.text, 'first')
    assert.equal(res.lines[1]!.text.length, 512, 'over-long line returned clipped, not dropped')
    assert.equal(res.lines[1]!.truncated, true)
    assert.equal(res.lines[2]!.text, 'third')
    assert.deepEqual(res.truncatedLineNumbers, [2])
    assert.equal(res.lineTooLongCount, 1)
  })
})

// Keep the imported type referenced so the RED import is meaningful.
const _budgetShape: ScanBudget = {}
void _budgetShape
