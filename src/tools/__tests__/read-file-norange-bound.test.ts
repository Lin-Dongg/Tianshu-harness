import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFilePayload, READ_FILE_TOOL } from '../read-file.js'

/**
 * P0 §3.2 — a no-range read of a large file must not materialise the whole file
 * (the line split, not the read, is what exhausts the heap on a short-line
 * file). It takes a bounded head page and says how to continue.
 */
describe('read_file no-range bound on large files', () => {
  let dir: string
  before(() => { dir = mkdtempSync(join(tmpdir(), 'read-head-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('bounds a no-range read of a large file and tells the model how to continue', async () => {
    const p = join(dir, 'huge.txt')
    writeFileSync(p, ('x'.repeat(30) + '\n').repeat(120_000)) // ~3.7 MB
    const payload = await readFilePayload(dir, { filePath: p })
    assert.ok(
      payload.rawContent.length < 1_000_000,
      `raw content must stay bounded, got ${payload.rawContent.length} chars`,
    )
    assert.match(payload.modelContent, /仅返回前部|offset\/limit/)
  })

  it('still reads a small file in full', async () => {
    const p = join(dir, 'small.txt')
    writeFileSync(p, 'hello\nworld\n')
    const payload = await readFilePayload(dir, { filePath: p })
    assert.equal(payload.rawContent, 'hello\nworld\n')
    assert.ok(!/仅返回前部/.test(payload.modelContent))
  })

  it('does not present the bounded head as the file (size/line-count)', async () => {
    // The PARTIAL-view / preview headers state the line and char counts of the
    // content they were given. Feeding them the bounded head made the model
    // report a 48 MB file as "16385 lines / 278544 chars" (found in a real run).
    const p = join(dir, 'long-head.txt')
    writeFileSync(p, ('y'.repeat(30) + '\n').repeat(200_000)) // ~6.2 MB
    const payload = await readFilePayload(dir, { filePath: p })
    assert.ok(
      !/PARTIAL view of|looks like a log/.test(payload.modelContent),
      `head must not be presented as the file: ${payload.modelContent.slice(0, 160)}`,
    )
    assert.match(payload.modelContent, /仅返回前部/, 'the bounded head must be declared')
    assert.match(payload.modelContent, /\d+\.\d+ MB/, 'the true file size must be stated')
  })

  it('marks the bounded head as partial in the UI channel too', async () => {
    const p = join(dir, 'ui-marker.txt')
    writeFileSync(p, ('z'.repeat(30) + '\n').repeat(120_000))
    const payload = await readFilePayload(dir, { filePath: p })
    assert.equal(payload.headBounded, true)
    assert.match(payload.uiContent, /仅返回文件前部/, 'the UI must not present the head as the file')
  })

  it('never claims a bounded head was read in full (dedup / read-ref)', async () => {
    // The head's line count is not the file's — registering it as a full read
    // produced "此文件本轮已完整读取过且未变更 (16385 lines)" against a 48 MB file.
    const p = join(dir, 'repeat.txt')
    writeFileSync(p, ('w'.repeat(30) + '\n').repeat(120_000))
    const params = { input: { file_path: p }, toolUseId: 't', cwd: dir, sessionId: 'sess-head' }
    await READ_FILE_TOOL.execute(params)
    const second = await READ_FILE_TOOL.execute(params)
    assert.ok(
      !/已完整读取过|已读取过且未变更/.test(second.content),
      `must not claim a full read: ${second.content.slice(0, 200)}`,
    )
    assert.match(second.content, /仅返回前部/)
  })
})
