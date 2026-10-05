import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GREP_TOOL, GREP_EMPTY_RESULT, resetRgResolvedPath } from '../grep.js'
import { resetResolvedEnvCache } from '../resolved-env.js'
import { hashLine } from '../hash-edit.js'

/**
 * P0 grep fallback — the native path must not retain every scanned line, and
 * an early end must never be reported as "no matches".
 */
describe('GREP_TOOL bounded fallback (P0)', () => {
  let dir: string
  before(() => { dir = mkdtempSync(join(tmpdir(), 'grep-bounded-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Force the native fallback path: empty PATH + disabled env.resolve, mirroring
   *  the existing slow-fallback test, so rg resolution fails deterministically. */
  function nativeOnly(root: string): void {
    writeFileSync(join(root, '.rivet-config.json'), JSON.stringify({ env: { resolve: false } }))
    resetResolvedEnvCache()
  }

  it('rejects out-of-range max_results and context_lines', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const X = 1\n')
    for (const input of [
      { pattern: 'X', path: 'a.ts', max_results: 0 },
      { pattern: 'X', path: 'a.ts', max_results: -3 },
      { pattern: 'X', path: 'a.ts', context_lines: 21 },
      { pattern: 'X', path: 'a.ts', context_lines: -1 },
    ]) {
      const res = await GREP_TOOL.execute({ input, toolUseId: 't', cwd: dir })
      assert.equal(res.isError, true, JSON.stringify(input))
      assert.match(res.content, /错误：/)
    }
  })

  it('reports an over-long line as incomplete, never as "no matches"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grep-longline-'))
    const savedPath = process.env.PATH
    try {
      nativeOnly(root)
      resetRgResolvedPath()
      process.env.PATH = join(root, 'no-binaries-here')
      // One 300 KiB line (> the 256 KiB per-line ceiling), no trailing newline.
      writeFileSync(join(root, 'huge.txt'), 'x'.repeat(300 * 1024))

      const res = await GREP_TOOL.execute({
        input: { pattern: 'NEEDLE_ABSENT', path: 'huge.txt', literal: true },
        toolUseId: 't',
        cwd: root,
      })
      assert.ok(!res.isError, res.content)
      assert.ok(res.content.includes('不完整'), `must flag incompleteness: ${res.content.slice(0, 200)}`)
      assert.ok(
        !res.content.includes(GREP_EMPTY_RESULT),
        'a skipped over-long line means "no match" is not a trustworthy exclusion',
      )
    } finally {
      process.env.PATH = savedPath
      resetResolvedEnvCache()
      resetRgResolvedPath()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still emits hash_edit anchors via a bounded re-scan (match on line 1 of a big file)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grep-anchor-'))
    const savedPath = process.env.PATH
    try {
      nativeOnly(root)
      resetRgResolvedPath()
      process.env.PATH = join(root, 'no-binaries-here')
      const needle = 'const ANCHOR_NEEDLE = 42'
      const body = Array.from({ length: 200_000 }, (_, i) => `filler line ${i}`).join('\n')
      writeFileSync(join(root, 'big.ts'), `${needle}\n${body}\n`)

      const res = await GREP_TOOL.execute({
        input: { pattern: 'ANCHOR_NEEDLE', path: 'big.ts', literal: true },
        toolUseId: 't',
        cwd: root,
      })
      assert.ok(!res.isError, res.content)
      assert.ok(res.content.includes('hash_edit 锚点'), `anchor hint expected: ${res.content.slice(0, 200)}`)
      assert.ok(res.content.includes(`L1:${hashLine(needle)}`), 'anchor must hash the intact original line')
    } finally {
      process.env.PATH = savedPath
      resetResolvedEnvCache()
      resetRgResolvedPath()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('surfaces an aborted signal instead of scanning', async () => {
    writeFileSync(join(dir, 'b.ts'), 'const Y = 2\n')
    const ac = new AbortController()
    ac.abort()
    const res = await GREP_TOOL.execute({
      input: { pattern: 'Y', path: 'b.ts', literal: true },
      toolUseId: 't',
      cwd: dir,
      abortSignal: ac.signal,
    })
    assert.equal(res.isError, true)
    assert.match(res.content, /已取消/)
  })

  it('anchors are not misaligned by an over-long line inside the scanned range', async () => {
    // collectAnchorLines scans the [min..max] span of hit line numbers. If an
    // over-long line in that span is skipped, positional mapping (min + i) would
    // assign LATER anchors to EARLIER lines — a wrong hash_edit anchor edits the
    // wrong line. Anchors must be bound by real line number.
    const root = mkdtempSync(join(tmpdir(), 'grep-anchor-align-'))
    const savedPath = process.env.PATH
    try {
      nativeOnly(root)
      resetRgResolvedPath()
      process.env.PATH = join(root, 'no-binaries-here')
      const l1 = 'needle A'
      const l3 = 'needle B'
      const l4 = 'needle C'
      writeFileSync(join(root, 'big.ts'), [l1, 'z'.repeat(300 * 1024), l3, l4].join('\n') + '\n')

      const res = await GREP_TOOL.execute({
        input: { pattern: 'needle', path: 'big.ts', literal: true },
        toolUseId: 't',
        cwd: root,
      })
      assert.ok(!res.isError, res.content)
      assert.ok(res.content.includes(`L1:${hashLine(l1)}`), `L1 anchor wrong: ${res.content.slice(-200)}`)
      assert.ok(res.content.includes(`L3:${hashLine(l3)}`), `L3 anchor must hash line 3, not a shifted line: ${res.content.slice(-200)}`)
      assert.ok(res.content.includes(`L4:${hashLine(l4)}`), `L4 anchor wrong: ${res.content.slice(-200)}`)
    } finally {
      process.env.PATH = savedPath
      resetResolvedEnvCache()
      resetRgResolvedPath()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
