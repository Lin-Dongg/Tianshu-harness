import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  chmodSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDocument, saveDocument, DocumentError } from '../file-document.js'
import {
  writePlan,
  readPlan,
  approvePlan,
  PlanConflictError,
} from '../../plan/plan-store.js'
test('optimistic file saves reject stale versions and preserve both disk and draft', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'content-cas-'))
  try {
    writeFileSync(join(cwd, 'note.md'), '# Original')
    const doc = readDocument(cwd, 'note.md')
    writeFileSync(join(cwd, 'note.md'), '# External')
    assert.throws(
      () => saveDocument(cwd, 'note.md', '# Draft', doc.version),
      (e: unknown) => e instanceof DocumentError && e.status === 409,
    )
    assert.equal(readFileSync(join(cwd, 'note.md'), 'utf8'), '# External')
    chmodSync(join(cwd, 'note.md'), 0o664)
    const next = saveDocument(
      cwd,
      'note.md',
      '# Saved',
      readDocument(cwd, 'note.md').version,
    )
    assert.equal(next.content, '# Saved')
    if (process.platform !== 'win32')
      assert.equal(statSync(join(cwd, 'note.md')).mode & 0o777, 0o664)
    assert.notEqual(next.version, doc.version)
    assert.throws(() => saveDocument(cwd, 'note.md', '# overwrite', '', true))
    assert.equal(readDocument(cwd, 'note.md').content, '# Saved')
    assert.equal(
      saveDocument(cwd, 'copy.md', '# Draft', '', true).content,
      '# Draft',
    )
    assert.throws(() => readDocument(cwd, '../outside.md'))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
test('non UTF-8 documents remain readable but cannot be edited; UTF-8 BOM survives save', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'content-encoding-'))
  try {
    writeFileSync(
      join(cwd, 'gbk.csv'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 44, 49]),
    )
    const doc = readDocument(cwd, 'gbk.csv')
    assert.equal(doc.content, '中文,1')
    assert.equal(doc.editable, false)
    assert.throws(
      () => saveDocument(cwd, 'gbk.csv', 'draft', doc.version),
      (e: unknown) => e instanceof DocumentError && e.status === 415,
    )
    writeFileSync(join(cwd, 'bom.txt'), '\uFEFFOriginal')
    saveDocument(cwd, 'bom.txt', 'Edited', readDocument(cwd, 'bom.txt').version)
    assert.equal(readFileSync(join(cwd, 'bom.txt'), 'utf8'), '\uFEFFEdited')
    mkdirSync(join(cwd, '.rivet/plans'), { recursive: true })
    writeFileSync(join(cwd, '.rivet/plans/p.md'), '# Plan')
    assert.throws(() =>
      saveDocument(cwd, '.rivet/plans/p.md', 'Bypass', '', false),
    )
    assert.throws(() =>
      saveDocument(cwd, '.rivet/plans/new.md', 'Bypass', '', true),
    )
    assert.equal(
      existsSync(join(cwd, '.rivet/plans/new.md')),
      false,
      'plan save-as must fail before creating a file',
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
test('plan CAS rejects simultaneous saves and approval changes without erasing status', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-cas-'))
  try {
    await writePlan(cwd, 'p', '# Original')
    const original = (await readPlan(cwd, 'p'))!
    const results = await Promise.allSettled([
      writePlan(cwd, 'p', '# One', undefined, original.content),
      writePlan(cwd, 'p', '# Two', undefined, original.content),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const failed = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult
    assert.ok(failed.reason instanceof PlanConflictError)
    const before = (await readPlan(cwd, 'p'))!
    await approvePlan(cwd, 'p')
    await assert.rejects(
      writePlan(cwd, 'p', '# Draft', undefined, before.content),
      PlanConflictError,
    )
    assert.equal((await readPlan(cwd, 'p'))?.status, 'approved')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
