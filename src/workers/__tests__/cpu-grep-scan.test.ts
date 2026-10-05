import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cpuPool } from '../cpu-pool.js'
import { GREP_TOOL, resetRgResolvedPath } from '../../tools/grep.js'
import type { GrepScanRawResult } from '../grep-scan-task.js'

/**
 * Guards the grep regex isolation wiring: the worker entry must load
 * cpu-tasks.ts (which imports bounded-scan) and register `grepScanRaw`.
 * A `.js` import specifier there fails the whole worker load in dev — this
 * catches that without needing a catastrophic-backtracking pattern.
 */
describe('cpu worker: grepScanRaw wiring', () => {
  let dir: string
  before(() => { dir = mkdtempSync(join(tmpdir(), 'cpu-grepscan-')) })
  after(() => {
    cpuPool.dispose() // release the worker so the test process can exit
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs a regex scan inside the worker and returns matches', async () => {
    const p = join(dir, 'a.txt')
    writeFileSync(p, 'needle here\nother line\nanother needle\n')
    const res = (await cpuPool.run(
      'grepScanRaw',
      [p, 'needle', '', 0, 10, 262144, 5_000],
      5_000,
    )) as GrepScanRawResult
    assert.equal(res.matchCount, 2)
    assert.deepEqual(res.lines.map(l => l.lineNumber), [1, 3])
    assert.equal(res.lines[0]!.text, 'needle here')
  })

  it('routes regex patterns through the worker task', async () => {
    const p = join(dir, 'dispatch.txt')
    writeFileSync(p, 'needle one\nother\nneedle two\n')
    const savedPath = process.env.RIVET_RIPGREP_PATH
    const orig = cpuPool.run
    const calls: string[] = []
    // Force the native fallback, else ripgrep answers and the dispatch is never reached.
    process.env.RIVET_RIPGREP_PATH = '/nonexistent/rg-for-test'
    resetRgResolvedPath()
    // Observe the dispatch without changing it: record and delegate.
    ;(cpuPool as unknown as { run: typeof orig }).run = (task, args, softMs) => {
      calls.push(task)
      return orig.call(cpuPool, task, args, softMs)
    }
    try {
      const res = await GREP_TOOL.execute({
        input: { pattern: 'needle', path: 'dispatch.txt' },
        toolUseId: 't',
        cwd: dir,
      })
      assert.ok(res.content.includes('needle'), res.content)
      assert.deepEqual(calls, ['grepScanRaw'], 'a regex pattern must scan in the worker')
    } finally {
      ;(cpuPool as unknown as { run: typeof orig }).run = orig
      process.env.RIVET_RIPGREP_PATH = savedPath
      resetRgResolvedPath()
    }
  })

  it('keeps literal patterns inline (no worker call)', async () => {
    const p = join(dir, 'literal.txt')
    writeFileSync(p, 'needle one\nneedle two\n')
    const savedPath = process.env.RIVET_RIPGREP_PATH
    const orig = cpuPool.run
    const calls: string[] = []
    process.env.RIVET_RIPGREP_PATH = '/nonexistent/rg-for-test'
    resetRgResolvedPath()
    ;(cpuPool as unknown as { run: typeof orig }).run = (task, args, softMs) => {
      calls.push(task)
      return orig.call(cpuPool, task, args, softMs)
    }
    try {
      const res = await GREP_TOOL.execute({
        input: { pattern: 'needle', path: 'literal.txt', literal: true },
        toolUseId: 't',
        cwd: dir,
      })
      assert.ok(res.content.includes('needle'), res.content)
      assert.deepEqual(calls, [], 'literal patterns cannot backtrack and must stay inline')
    } finally {
      ;(cpuPool as unknown as { run: typeof orig }).run = orig
      process.env.RIVET_RIPGREP_PATH = savedPath
      resetRgResolvedPath()
    }
  })
})
