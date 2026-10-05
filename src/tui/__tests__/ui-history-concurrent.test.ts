import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UIHistory } from '../ui-history.js'

test('读取末页期间追加记录，不误报缺失、不暂停保存、不缓存过期末页', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? tmpdir(), 'ui-history-race-'))
  const path = join(directory, 'ui-history.jsonl')
  const history = await UIHistory.open(path)
  history.append({ kind: 'assistant', text: 'FIRST' })
  const original = fs.createReadStream
  try {
    // 真正读取文件；在 EOF 与分页续体之间模拟模型回调追加记录。
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      const stream = original(...args)
      stream.once('end', () => { for (let i = 0; i < 200; i++) history.append({ kind: 'tool', name: 'read_file', text: `LIVE_${i}` }) })
      return stream
    }) as typeof original
    syncBuiltinESMExports()
    assert.equal((await history.page(0, 1))[0]?.text, 'FIRST')
    fs.createReadStream = original
    syncBuiltinESMExports()
    assert.equal(history.diagnostic, '')
    assert.equal((await history.page(1, 1))[0]?.text, 'LIVE_0')
    history.append({ kind: 'assistant', text: 'NEXT_REPLY' })
    const reopened = await UIHistory.open(path)
    assert.equal(reopened.count, 202)
    assert.equal((await reopened.page(201, 1))[0]?.text, 'NEXT_REPLY')
  } finally {
    fs.createReadStream = original
    syncBuiltinESMExports()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('真实文件被截断时仍明确警告并暂停写入，避免覆盖受损历史', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? tmpdir(), 'ui-history-truncated-'))
  const path = join(directory, 'ui-history.jsonl')
  try {
    const history = await UIHistory.open(path)
    for (let i = 0; i < 200; i++) history.append({ kind: 'assistant', text: `record ${i}` })
    writeFileSync(path, '')
    const records = await history.page(0, 1)
    assert.equal(records[0]?.kind, 'error')
    assert.match(history.diagnostic, /暂停保存/)
    history.append({ kind: 'assistant', text: 'RECENT_UNSAVED' })
    assert.equal(readFileSync(path, 'utf8'), '')
    assert.equal((await history.page(200, 1))[0]?.text, 'RECENT_UNSAVED')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
