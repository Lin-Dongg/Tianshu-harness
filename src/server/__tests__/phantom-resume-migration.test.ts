/**
 * P0-4 假中断标记一次性迁移——测试。
 *
 * 夹具形状取自真实受损会话（只读核验，见模块头注释）：
 *   ~/.rivet/desktop/sessions/2026100340b5a1049972/events.jsonl
 *   line 30608  seq=30608  delegation       ← 真实 run 的最后一笔落盘
 *   line 30609  seq=130609 status{aborted, reason:sidecar-restart}  ← 假标记（30608+100000+1）
 *   line 30610  seq=130610 resume_offer{...}                        ← 假标记
 *   line 30611  seq=30609  delegation       ← 真实 run 继续写的小 seq
 * 前端 event-reducer 的 `ev.seq <= state.lastSeq` 守卫会把 30609 起的真实输出全丢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPhantomResumeMigration } from '../phantom-resume-migration.js'

interface Fixture {
  root: string
  sessionsDir: string
  backupPath: string
  doneMarkerPath: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rivet-phantom-resume-'))
  const sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  return {
    root,
    sessionsDir,
    backupPath: join(root, '.migrations', 'phantom-resume-v1.removed.jsonl'),
    doneMarkerPath: join(root, '.migrations', 'phantom-resume-v1.done'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 写一个会话目录：events.jsonl（原始行数组，逐字落盘）+ 三份派生缓存。 */
function writeSession(sessionsDir: string, id: string, lines: string[]): string {
  const dir = join(sessionsDir, id)
  mkdirSync(join(dir, 'events.summary-blocks'), { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, 'events.index.jsonl'), '{"seq":1,"offset":0}\n', 'utf8')
  writeFileSync(join(dir, 'events.summary.json'), '{"stale":true}\n', 'utf8')
  writeFileSync(join(dir, 'events.summary-blocks', '0.json'), '{}\n', 'utf8')
  return dir
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n')
}

// ── 真实形状夹具（10/03 会话 2026100340b5a1049972 逐字轮廓） ─────────────────
const DELEGATION_30608 =
  '{"seq":30608,"ts":1791033032461,"type":"delegation","data":{"workerId":"call_00_H2Q1Ts5A4vEFdPla87yG5741-galaxy-4:0","status":"running"}}'
const PHANTOM_STATUS_130609 =
  '{"seq":130609,"ts":1791033035476,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}'
const PHANTOM_RESUME_130610 =
  '{"seq":130610,"ts":1791033035476,"type":"resume_offer","data":{"model":"deepseek-spark:default:deepseek-v4-flash","domain":"tianliang"}}'
const DELEGATION_30609 =
  '{"seq":30609,"ts":1791033035705,"type":"delegation","data":{"workerId":"call_00_H2Q1Ts5A4vEFdPla87yG5741-galaxy-4:0","status":"running"}}'
const TOOL_RESULT_30610 =
  '{"seq":30610,"ts":1791033036113,"type":"tool_result","data":{"id":"call_00_H2Q1Ts5A4vEFdPla87yG5741","name":"galaxy","isError":false,"partial":true}}'

const REAL_SHAPE = [
  '{"seq":30607,"ts":1791033032453,"type":"delegation","data":{"status":"running"}}',
  DELEGATION_30608,
  PHANTOM_STATUS_130609,
  PHANTOM_RESUME_130610,
  DELEGATION_30609,
  TOOL_RESULT_30610,
]

test('a) 真实形状：只删假标记段，前后真实事件原样保留', async () => {
  const fx = makeFixture()
  try {
    const id = '2026100340b5a1049972'
    const dir = writeSession(fx.sessionsDir, id, REAL_SHAPE)

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.equal(report.scanned, 1)
    assert.deepEqual(report.repaired, [id])
    assert.deepEqual(report.failed, [])

    const after = readLines(join(dir, 'events.jsonl'))
    assert.deepEqual(after, [
      '{"seq":30607,"ts":1791033032453,"type":"delegation","data":{"status":"running"}}',
      DELEGATION_30608,
      DELEGATION_30609,
      TOOL_RESULT_30610,
      '',
    ])

    // 备份逐行记录被删原始行 + 原始索引（可还原）
    const backup = readLines(fx.backupPath).filter((l) => l.trim())
    assert.deepEqual(backup, [
      JSON.stringify({ sessionId: id, index: 2, line: PHANTOM_STATUS_130609 }),
      JSON.stringify({ sessionId: id, index: 3, line: PHANTOM_RESUME_130610 }),
    ])

    // 派生缓存被删除（交给 rebuildAndSlice 自愈重建）
    assert.equal(existsSync(join(dir, 'events.index.jsonl')), false)
    assert.equal(existsSync(join(dir, 'events.summary.json')), false)
    assert.equal(existsSync(join(dir, 'events.summary-blocks')), false)
  } finally {
    fx.cleanup()
  }
})

test('a2) 同会话多段 + 裸 status{aborted} 段（真实 ef8517d5 形状）全部清除', async () => {
  const fx = makeFixture()
  try {
    const id = 'multi'
    const dir = writeSession(fx.sessionsDir, id, [
      '{"seq":100,"type":"user","data":{}}',
      '{"seq":100100,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}',
      '{"seq":100101,"type":"resume_offer","data":{}}',
      '{"seq":101,"type":"tool_result","data":{}}',
      '{"seq":150,"type":"thinking_delta","data":{}}',
      '{"seq":100150,"type":"status","data":{"status":"aborted"}}',
      '{"seq":151,"type":"tool_result","data":{}}',
    ])

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.deepEqual(report.repaired, [id])
    assert.deepEqual(readLines(join(dir, 'events.jsonl')), [
      '{"seq":100,"type":"user","data":{}}',
      '{"seq":101,"type":"tool_result","data":{}}',
      '{"seq":150,"type":"thinking_delta","data":{}}',
      '{"seq":151,"type":"tool_result","data":{}}',
      '',
    ])
  } finally {
    fx.cleanup()
  }
})

test('b) 跳号段混入其他类型 → 整个文件不动', async () => {
  const fx = makeFixture()
  try {
    const id = 'dirty'
    const dir = writeSession(fx.sessionsDir, id, [
      '{"seq":100,"type":"user","data":{}}',
      '{"seq":100100,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}',
      '{"seq":100101,"type":"resume_offer","data":{}}',
      // 跳号段里出现不属于三种标记的类型 → 宁可少删，跳过
      '{"seq":100102,"type":"tool_result","data":{}}',
      '{"seq":101,"type":"tool_result","data":{}}',
    ])
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8')

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.deepEqual(report.repaired, [])
    assert.deepEqual(report.skipped, [{ id, reason: 'jump-segment-not-marker-only' }])
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before)
    assert.equal(existsSync(fx.backupPath), false)
    assert.equal(existsSync(join(dir, 'events.index.jsonl')), true)
  } finally {
    fx.cleanup()
  }
})

test('c) 真实崩溃恢复形状（跳号后序号也高）→ 不动文件', async () => {
  const fx = makeFixture()
  try {
    const id = 'realcrash'
    const dir = writeSession(fx.sessionsDir, id, [
      '{"seq":100,"type":"tool_result","data":{}}',
      '{"seq":100100,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}',
      '{"seq":100101,"type":"resume_offer","data":{}}',
      '{"seq":100102,"type":"delegation","data":{}}',
      '{"seq":100103,"type":"tool_result","data":{}}',
    ])
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8')

    // c2：跳高段「只含标记」，但没有回落（标记落在文件尾）——这是真崩溃恢复
    // 且尚未续跑，中断原因必须保留，绝不能删。它单独隔离「必须有回落」这条约束。
    const id2 = 'realcrash-marker-tail'
    const dir2 = writeSession(fx.sessionsDir, id2, [
      '{"seq":100,"type":"tool_result","data":{}}',
      '{"seq":100100,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}',
      '{"seq":100101,"type":"resume_offer","data":{}}',
    ])
    const before2 = readFileSync(join(dir2, 'events.jsonl'), 'utf8')

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.deepEqual(report.repaired, [])
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before)
    assert.equal(readFileSync(join(dir2, 'events.jsonl'), 'utf8'), before2)
    assert.equal(existsSync(join(dir, 'events.index.jsonl')), true)
    assert.equal(existsSync(join(dir2, 'events.index.jsonl')), true)
  } finally {
    fx.cleanup()
  }
})

test('d) 标记文件存在 → 直接返回空报告，不动任何会话', async () => {
  const fx = makeFixture()
  try {
    const id = 'guarded'
    const dir = writeSession(fx.sessionsDir, id, REAL_SHAPE)
    mkdirSync(join(fx.root, '.migrations'), { recursive: true })
    writeFileSync(fx.doneMarkerPath, '{"version":"phantom-resume-v1"}\n', 'utf8')
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8')

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.deepEqual(report, { scanned: 0, repaired: [], skipped: [], failed: [] })
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before)
  } finally {
    fx.cleanup()
  }
})

test('e) 备份可还原：把备份行按原索引插回 = 原文件', async () => {
  const fx = makeFixture()
  try {
    const id = '2026100340b5a1049972'
    const dir = writeSession(fx.sessionsDir, id, REAL_SHAPE)
    const original = readLines(join(dir, 'events.jsonl'))

    await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    const migrated = readLines(join(dir, 'events.jsonl'))
    const backup = readLines(fx.backupPath).filter((l) => l.trim()).map((l) => JSON.parse(l) as { sessionId: string; index: number; line: string })

    // 按原始下标升序插回：删除集合 R 的最小子集先归位，每步插入点即原始下标。
    const restored = migrated.slice()
    for (const rec of [...backup].sort((a, b) => a.index - b.index)) {
      assert.equal(rec.sessionId, id)
      restored.splice(rec.index, 0, rec.line)
    }
    assert.deepEqual(restored, original)
  } finally {
    fx.cleanup()
  }
})

test('h) 高位平台内部嵌着的假标记段也要删（真实 f92959da0d34 形状）', async () => {
  // 一次回退（seq 100→13）把后续真实序号整体抬到 14077 起的长平台；平台本身
  // 永不回落（不是假标记），但平台内部嵌着一段 22648→122649（+100001）的假标记
  // 段，其后紧跟 22649（更小）。误把整段平台当「无回落」一口吞掉，就会漏掉内嵌段。
  const fx = makeFixture()
  try {
    const id = 'plateau'
    const dir = writeSession(fx.sessionsDir, id, [
      '{"seq":100,"type":"tool_result","data":{}}',
      '{"seq":13,"type":"status","data":{"status":"aborted"}}',
      '{"seq":14077,"type":"tool_result","data":{}}',
      '{"seq":14078,"type":"hook_result","data":{}}',
      '{"seq":22648,"type":"tool_result","data":{}}',
      '{"seq":122649,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}',
      '{"seq":122650,"type":"resume_offer","data":{}}',
      '{"seq":22649,"type":"tool_result","data":{}}',
      '{"seq":22650,"type":"turn_complete","data":{}}',
    ])

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.deepEqual(report.repaired, [id])
    assert.deepEqual(readLines(join(dir, 'events.jsonl')), [
      '{"seq":100,"type":"tool_result","data":{}}',
      '{"seq":13,"type":"status","data":{"status":"aborted"}}',
      '{"seq":14077,"type":"tool_result","data":{}}',
      '{"seq":14078,"type":"hook_result","data":{}}',
      '{"seq":22648,"type":"tool_result","data":{}}',
      '{"seq":22649,"type":"tool_result","data":{}}',
      '{"seq":22650,"type":"turn_complete","data":{}}',
      '',
    ])
  } finally {
    fx.cleanup()
  }
})

test('i) 跳号段里夹了坏行（非空不可解析）→ 宁可少删，文件不动', async () => {
  const fx = makeFixture()
  try {
    const id = 'blob'
    const dir = writeSession(fx.sessionsDir, id, [
      '{"seq":100,"type":"user","data":{}}',
      '{"seq":100100,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}',
      '{ this is not valid json',
      '{"seq":100101,"type":"resume_offer","data":{}}',
      '{"seq":101,"type":"tool_result","data":{}}',
    ])
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8')

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.deepEqual(report.repaired, [])
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before)
  } finally {
    fx.cleanup()
  }
})

test('f) 正在运行的会话被跳过，不入报告 repaired', async () => {
  const fx = makeFixture()
  try {
    const id = 'running'
    const dir = writeSession(fx.sessionsDir, id, REAL_SHAPE)
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8')

    const report = await runPhantomResumeMigration({
      sessionsDir: fx.sessionsDir,
      removedBackupPath: fx.backupPath,
      doneMarkerPath: fx.doneMarkerPath,
      isSessionRunning: (sid) => sid === id,
    })

    assert.deepEqual(report.repaired, [])
    assert.deepEqual(report.skipped, [{ id, reason: 'session-running' }])
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before)
  } finally {
    fx.cleanup()
  }
})

test('g) 无跳号的正常会话不动，且不算 repaired', async () => {
  const fx = makeFixture()
  try {
    const id = 'clean'
    const dir = writeSession(fx.sessionsDir, id, [
      '{"seq":1,"type":"user","data":{}}',
      '{"seq":2,"type":"tool_result","data":{}}',
      '{"seq":3,"type":"turn_complete","data":{}}',
    ])
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8')

    const report = await runPhantomResumeMigration({ sessionsDir: fx.sessionsDir, removedBackupPath: fx.backupPath, doneMarkerPath: fx.doneMarkerPath })

    assert.equal(report.scanned, 1)
    assert.deepEqual(report.repaired, [])
    assert.deepEqual(report.skipped, [])
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before)
  } finally {
    fx.cleanup()
  }
})
