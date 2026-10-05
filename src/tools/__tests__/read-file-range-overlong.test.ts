import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFilePayload } from '../read-file.js'

/**
 * P0 review fix — explicit-range reads must not silently drop over-long lines.
 *
 * bounded-scan skips a line longer than its per-line ceiling (>256 KiB) while
 * still incrementing the line counter. A range read that only looked at
 * `lines`/`totalLines` therefore (a) fabricated an out-of-range error for a
 * single over-long line and (b) silently lost lines inside the window, shifting
 * every later line. A range read must instead return such lines truncated.
 */
describe('read_file explicit range vs over-long lines', () => {
  let dir: string
  before(() => { dir = mkdtempSync(join(tmpdir(), 'read-range-long-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('does not fabricate "offset exceeds file length" for a single over-long line', async () => {
    const p = join(dir, 'one-long.txt')
    writeFileSync(p, 'z'.repeat(300 * 1024)) // one line, > 256 KiB ceiling
    const payload = await readFilePayload(dir, { filePath: p, offset: 1, limit: 10 })
    assert.ok(
      !/exceeds file length/.test(payload.modelContent),
      `must not error out a valid range: ${payload.modelContent.slice(0, 140)}`,
    )
    assert.ok(payload.modelContent.includes('z'), 'the line content must be returned (possibly truncated)')
  })

  it('keeps an over-long line inside the window instead of silently dropping it', async () => {
    const p = join(dir, 'mixed.txt')
    writeFileSync(p, ['first', 'y'.repeat(300 * 1024), 'third', 'fourth'].join('\n') + '\n')
    const payload = await readFilePayload(dir, { filePath: p, offset: 1, limit: 4 })
    assert.ok(payload.modelContent.includes('first'), 'line 1 present')
    assert.ok(payload.modelContent.includes('y'), 'line 2 (over-long) must not vanish')
    assert.ok(payload.modelContent.includes('third'), 'line 3 present')
    assert.ok(payload.modelContent.includes('fourth'), 'line 4 present')
  })

  it('still reports a genuine out-of-range offset', async () => {
    const p = join(dir, 'short.txt')
    writeFileSync(p, 'a\nb\nc\n')
    const payload = await readFilePayload(dir, { filePath: p, offset: 10, limit: 2 })
    assert.match(payload.modelContent, /exceeds file length \(3 lines\)/)
  })

  it('returns empty content for an explicit range on an empty file', async () => {
    // Regression guard: a 0-byte file has no lines, but reading offset=1 from it
    // must NOT be reported as out-of-range.
    const p = join(dir, 'empty.txt')
    writeFileSync(p, '')
    const payload = await readFilePayload(dir, { filePath: p, offset: 1, limit: 10 })
    assert.ok(
      !/exceeds file length/.test(payload.modelContent),
      `empty file must not fabricate an out-of-range error: ${payload.modelContent.slice(0, 120)}`,
    )
  })

  it('surfaces truncated lines with the effective per-line limit', async () => {
    const p = join(dir, 'note.txt')
    writeFileSync(p, 'short\n' + 'q'.repeat(300 * 1024) + '\n')
    const payload = await readFilePayload(dir, { filePath: p, offset: 1, limit: 2 })
    assert.match(payload.modelContent, /截断/, 'truncation must be surfaced to the model')
  })
})
