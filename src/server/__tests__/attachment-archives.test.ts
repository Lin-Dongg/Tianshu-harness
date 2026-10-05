/**
 * 压缩包附件（句柄式，2026-10-05）——validateArchivesPayload 线缆校验 +
 * 路由级落盘/句柄/事件契约。服务端不解压：原样落盘（content-addressed，
 * docId = 内容 sha256）+ ~90 token 句柄文本进 prompt，agent 自行 unzip/tar。
 *
 * 装配与 session-queue-attachments.test.ts 同源：真实 RuntimeSessionManager +
 * 真实 FileSessionPersistence（临时目录）+ 真实路由，只把 LLM 侧换成记录型
 * FakeAgent。队列消费走收尾 flush 路径（与 mergeQueuedIntoPrompt 同一实现）。
 */
import './disable-cpu-pool.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { validateArchivesPayload, buildArchiveHandleText } from '../attachment-validation.js'
import { MAX_ARCHIVES } from '../attachment-limits.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** 服务端从不解析压缩包内容——任意字节即可（PK 头只是伪装真实感）。 */
const ZIP_BYTES = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('archive-图标包-marker-v2'), Buffer.alloc(64, 7)])
const ZIP_SHA256 = createHash('sha256').update(ZIP_BYTES).digest('hex')

class RecordingAgent implements ManagedAgent {
  runs: Array<{ prompt: string; images?: string[] }> = []
  callbacks?: AgentCallbacks
  private resolveRun?: () => void

  run(p: string, cb: AgentCallbacks, images?: string[]) {
    this.runs.push(images === undefined ? { prompt: p } : { prompt: p, images })
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  finish() { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'archive-attachment-'))
  const persistence = new FileSessionPersistence(dir)
  const agents: RecordingAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new RecordingAgent(); agents.push(a); return a },
    defaultCwd: dir,
    persistence,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  const cleanup = async () => {
    // 先排空 write-behind 写链再 rm——链在飞时递归删除会 ENOTEMPTY（会话目录被重建）。
    await persistence.flushAllAsync().catch(() => {})
    await manager.shutdownAll()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  return { dir, persistence, manager, agents, router, cleanup }
}

/** 造一个带固定旧时 mtime 的源压缩包，返回路径（path 形态上传）。 */
function makeSourceArchive(dir: string, name: string, bytes: Buffer = ZIP_BYTES): string {
  const srcPath = join(dir, name)
  writeFileSync(srcPath, bytes)
  const past = new Date('2020-01-01T00:00:00Z')
  utimesSync(srcPath, past, past)
  return srcPath
}

/** 起一个运行中的会话，返回 id（首轮 run 挂起中）。 */
async function startBusySession(router: ReturnType<typeof setup>['router']): Promise<string> {
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  assert.equal(created.status, 201)
  return (created.body as { id: string }).id
}

/** run settle 后等收尾 flush 的 setImmediate 链跑完。 */
const settle = () => new Promise((r) => setTimeout(r, 20))

/** 抓二进制响应体的最小 ServerResponse 桩（GET 文档回读路由用）。 */
function fakeBinaryRes(): { res: ServerResponse; chunks: Buffer[]; head: { status: number; headers: unknown }[] } {
  const chunks: Buffer[] = []
  const head: { status: number; headers: unknown }[] = []
  const res = {
    writeHead: (status: number, headers: unknown) => { head.push({ status, headers }) },
    end: (data?: Buffer | string) => { if (data !== undefined) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)) },
  }
  return { res: res as unknown as ServerResponse, chunks, head }
}

function lastUserEvent(manager: RuntimeSessionManager, id: string) {
  const events = manager.getEvents(id, 0)!.events.filter((e) => e.type === 'user')
  return events[events.length - 1]!
}

// ── validateArchivesPayload 线缆校验 ─────────────────────────────────────

test('validateArchivesPayload: path 与 dataUrl 必须恰居其一', () => {
  const both = validateArchivesPayload([{ name: 'a.zip', path: '/tmp/a.zip', dataUrl: 'data:application/zip;base64,AAA=' }])
  assert.ok(both.error, 'path+dataUrl 同带应拒')
  assert.match(both.error!, /exactly one/)
  const neither = validateArchivesPayload([{ name: 'a.zip' }])
  assert.ok(neither.error, '两者都不带应拒')
  assert.match(neither.error!, /exactly one/)
})

test('validateArchivesPayload: path 形态必须是绝对路径', () => {
  const rel = validateArchivesPayload([{ name: 'a.zip', path: 'tmp/a.zip' }])
  assert.ok(rel.error)
  assert.match(rel.error!, /absolute/)
  const win = validateArchivesPayload([{ name: 'a.zip', path: 'C:\\archives\\a.zip' }])
  // POSIX 下 C:\ 不是绝对路径——校验按运行平台语义（桌面端与服务端同机）。
  if (process.platform === 'win32') assert.ok(!win.error)
  else assert.ok(win.error)
})

test('validateArchivesPayload: dataUrl 形态超 30MB 拒绝、形态非法拒绝', () => {
  // 按解码后字节计：42MB 的 base64 载荷 ≈ 31.5MB 解码字节 > 30MB 上限
  const huge = `data:application/zip;base64,${'A'.repeat(42 * 1024 * 1024)}`
  const tooBig = validateArchivesPayload([{ name: 'a.zip', dataUrl: huge }])
  assert.ok(tooBig.error)
  assert.match(tooBig.error!, /30MB/)
  const malformed = validateArchivesPayload([{ name: 'a.zip', dataUrl: 'not-a-data-url' }])
  assert.ok(malformed.error)
  assert.match(malformed.error!, /base64 data URL/)
})

test('validateArchivesPayload: 非白名单压缩格式拒绝（rar/7z/单文件 gz）', () => {
  for (const name of ['a.rar', 'b.7z', 'c.dmg', 'foo.gz', 'foo.bz2', 'foo.xz', 'pkg.iso']) {
    const res = validateArchivesPayload([{ name, path: '/tmp/x' }])
    assert.ok(res.error, `${name} 应被拒`)
    assert.match(res.error!, /supported archive type/)
  }
  // 危险文件名（路径穿越/隐藏文件）同样拒绝
  for (const name of ['../a.zip', '.env.zip', 'a/b.zip']) {
    assert.ok(validateArchivesPayload([{ name, path: '/tmp/x' }]).error, `${name} 应被拒`)
  }
})

test('validateArchivesPayload: 个数上限与空数组', () => {
  const three = validateArchivesPayload([
    { name: 'a.zip', path: '/tmp/a' },
    { name: 'b.zip', path: '/tmp/b' },
    { name: 'c.zip', path: '/tmp/c' },
  ])
  assert.ok(three.error)
  assert.match(three.error!, new RegExp(`Max ${MAX_ARCHIVES}`))
  assert.ok(validateArchivesPayload([]).error)
})

test('validateArchivesPayload: zip path 与 tar.gz dataUrl 正常放行', () => {
  const ok1 = validateArchivesPayload([{ name: 'icons.zip', path: '/tmp/icons.zip' }])
  assert.equal(ok1.error, undefined)
  assert.equal(ok1.archives!.length, 1)
  const ok2 = validateArchivesPayload([
    { name: 'icons.zip', path: '/tmp/icons.zip' },
    { name: 'bundle.tar.gz', dataUrl: `data:application/gzip;base64,${ZIP_BYTES.toString('base64')}` },
  ])
  assert.equal(ok2.error, undefined)
  assert.equal(ok2.archives!.length, 2)
})

test('buildArchiveHandleText: 格式与措辞稳定（名字/字节/sha256 前 8 位/只读路径/用法）', () => {
  const text = buildArchiveHandleText({
    name: 'icons.zip',
    bytes: 12.3 * 1024 * 1024,
    sha256short: 'abcd1234',
    savedPath: '/Users/x/.rivet/desktop/sessions/s1/documents/deadbeef.zip',
  })
  assert.equal(
    text,
    '[archive: icons.zip (12.3 MB, sha256:abcd1234)]\n' +
      'Saved verbatim at: /Users/x/.rivet/desktop/sessions/s1/documents/deadbeef.zip\n' +
      'Do not inline its contents. Inspect on demand: `unzip -l /Users/x/.rivet/desktop/sessions/s1/documents/deadbeef.zip` to list; ' +
      'extract into a writable workspace dir (`unzip /Users/x/.rivet/desktop/sessions/s1/documents/deadbeef.zip -d <dir>`) before reading. ' +
      'Pass this path in delegation prompts when workers need it.',
  )
})

// ── 路由级：path 形态（Tauri 原生拖拽）─────────────────────────────────

test('POST /prompt 带 zip（path 形态）→ 句柄进 prompt、原样落盘、源文件不动、副本只读', async () => {
  const { dir, manager, agents, router, cleanup } = setup()
  try {
    const srcPath = makeSourceArchive(dir, 'icons.zip')
    const srcMtime = statSync(srcPath).mtimeMs
    const rec = manager.createSession({ cwd: dir })
    const res = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: '看看这个压缩包',
      archives: [{ name: 'icons.zip', path: srcPath }],
    }, AUTH)
    assert.equal(res.status, 200)

    // 句柄文本：名字 + sha256 前 8 位 + 落盘路径 + 用法说明；绝不含 base64 原文
    const prompt = agents[0]!.runs[0]!.prompt
    assert.ok(prompt.includes(`[archive: icons.zip (`), 'prompt 应含句柄头')
    assert.ok(prompt.includes(`sha256:${ZIP_SHA256.slice(0, 8)}`), '句柄应带 sha256 前 8 位')
    const savedPath = /Saved verbatim at: (.+)/.exec(prompt)?.[1]
    assert.ok(savedPath, '句柄应带落盘路径')
    assert.ok(prompt.includes('Do not inline its contents.'))
    assert.ok(prompt.trimEnd().endsWith('看看这个压缩包'), '用户 prompt 本体保留在尾部')
    assert.ok(!prompt.includes(ZIP_BYTES.toString('base64')), 'prompt 不得携带 base64 原文')

    // 落盘字节与源一致，且在会话 documents 目录内（docId = 内容 sha256）
    assert.ok(savedPath!.startsWith(join(dir, rec.id, 'documents')), '副本应在会话 documents 目录')
    assert.ok(savedPath!.endsWith(`${ZIP_SHA256}.zip`), '落盘名应为内容哈希 + 原扩展名')
    assert.deepEqual(readFileSync(savedPath!), ZIP_BYTES)

    // 源文件内容与 mtime 不变（copyFile 绝不动原文件）
    assert.deepEqual(readFileSync(srcPath), ZIP_BYTES)
    assert.equal(statSync(srcPath).mtimeMs, srcMtime)

    // 副本只读（chmod 0o444；Windows ACL 语义不同，跳过）
    if (process.platform !== 'win32') {
      assert.equal(statSync(savedPath!).mode & 0o222, 0, '副本应为只读')
    }

    // user 事件：{id,name,bytes} 小引用——savedPath/sha256 不进事件流
    const user = lastUserEvent(manager, rec.id)
    const refs = user.data.archives as Array<Record<string, unknown>>
    assert.equal(refs.length, 1)
    assert.equal(refs[0]!.id, ZIP_SHA256)
    assert.equal(refs[0]!.name, 'icons.zip')
    assert.equal(refs[0]!.bytes, ZIP_BYTES.length)
    assert.ok(!('savedPath' in refs[0]!), '事件不得携带落盘路径')
    assert.ok(!('sha256short' in refs[0]!), '事件不得携带 sha256')
    assert.equal(user.data.promptText, '看看这个压缩包')
  } finally { await cleanup() }
})

test('POST /prompt 带 tar.gz（dataUrl 形态）→ 句柄进 prompt、保扩展名落盘', async () => {
  const { dir, manager, agents, router, cleanup } = setup()
  try {
    const rec = manager.createSession({ cwd: dir })
    const res = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: '解开看看',
      archives: [{ name: 'bundle.tar.gz', dataUrl: `data:application/gzip;base64,${ZIP_BYTES.toString('base64')}` }],
    }, AUTH)
    assert.equal(res.status, 200)
    const prompt = agents[0]!.runs[0]!.prompt
    assert.ok(prompt.includes('[archive: bundle.tar.gz ('))
    const savedPath = /Saved verbatim at: (.+)/.exec(prompt)?.[1]
    assert.ok(savedPath!.endsWith('.gz'), 'tar.gz 按 extname 保尾段扩展名')
    assert.deepEqual(readFileSync(savedPath!), ZIP_BYTES)
    assert.ok(!prompt.includes(ZIP_BYTES.toString('base64')))
    const refs = lastUserEvent(manager, rec.id).data.archives as Array<{ name: string }>
    assert.equal(refs[0]!.name, 'bundle.tar.gz')
  } finally { await cleanup() }
})

test('POST /sessions 建会话带 prompt + 压缩包 → 首轮 run 即含句柄', async () => {
  const { dir, manager, agents, router, cleanup } = setup()
  try {
    const srcPath = makeSourceArchive(dir, 'first.zip')
    const res = await router('POST', '/sessions', {
      prompt: '分析一下',
      archives: [{ name: 'first.zip', path: srcPath }],
    }, AUTH)
    assert.equal(res.status, 201)
    const prompt = agents[0]!.runs[0]!.prompt
    assert.ok(prompt.includes('[archive: first.zip ('))
    assert.ok(prompt.trimEnd().endsWith('分析一下'))
    const rec = res.body as { id: string }
    const refs = lastUserEvent(manager, rec.id).data.archives as Array<{ name: string }>
    assert.equal(refs.length, 1)
  } finally { await cleanup() }
})

// ── 路由级：拒绝路径 ────────────────────────────────────────────────────

test('POST /prompt 压缩包校验失败（rar / 相对路径 / 源文件不存在）→ 400', async () => {
  const { dir, manager, router, cleanup } = setup()
  try {
    const rec = manager.createSession({ cwd: dir })
    let res = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: 'x', archives: [{ name: 'a.rar', path: '/tmp/a.rar' }],
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /supported archive type/)

    res = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: 'x', archives: [{ name: 'a.zip', path: 'relative/a.zip' }],
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /absolute/)

    // 线缆校验通过但持久化时核不到源文件 → 400（path 形态的存在性在持久化时核）
    res = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: 'x', archives: [{ name: 'ghost.zip', path: join(dir, 'no-such.zip') }],
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /not found/)
  } finally { await cleanup() }
})

// ── 路由级：queue 路径 ──────────────────────────────────────────────────

test('queue 路径：排队压缩包入队时落盘 + 句柄拼接，归并后句柄/引用随下轮发出', async () => {
  const { dir, manager, agents, router, cleanup } = setup()
  try {
    const srcPath = makeSourceArchive(dir, 'queued.zip')
    const id = await startBusySession(router)

    const queued = await router('POST', `/sessions/${id}/queue`, {
      text: '排队带的压缩包',
      archives: [{ name: 'queued.zip', path: srcPath }],
    }, AUTH)
    assert.equal(queued.status, 200)

    // 入队即落盘（归并发生在下轮 run 的同步入口，届时不能 await 持久化）
    const pending = manager.getEvents(id, 0)!.events.find((e) => e.type === 'queue_pending')!
    assert.deepEqual(pending.data.archiveNames, ['queued.zip'])

    agents[0]!.finish()
    await settle()

    assert.equal(agents[0]!.runs.length, 2, '收尾 flush 应起新 run 消费 lane')
    const run = agents[0]!.runs[1]!
    const handleIdx = run.prompt.indexOf('[archive: queued.zip (')
    const textIdx = run.prompt.indexOf('排队带的压缩包')
    assert.ok(handleIdx >= 0, '归并 prompt 应含句柄文本')
    assert.ok(textIdx >= 0, '归并 prompt 应含排队文本')
    assert.ok(handleIdx < textIdx, '句柄应排在排队文本之前（attachmentText 模式）')

    const refs = lastUserEvent(manager, id).data.archives as Array<Record<string, unknown>>
    assert.equal(refs.length, 1, '归并后的 user 事件应携带压缩包引用')
    assert.equal(refs[0]!.name, 'queued.zip')
    assert.ok(!('savedPath' in refs[0]!))
  } finally { await cleanup() }
})

test('queue 路径：压缩包预算超限显式 400（archive_budget）', async () => {
  const { dir, router, cleanup } = setup()
  try {
    const srcPath = makeSourceArchive(dir, 'b1.zip')
    const id = await startBusySession(router)
    const first = await router('POST', `/sessions/${id}/queue`, {
      text: '占满压缩包配额',
      archives: [
        { name: 'b1.zip', path: srcPath },
        { name: 'b2.zip', dataUrl: `data:application/zip;base64,${ZIP_BYTES.toString('base64')}` },
      ],
    }, AUTH)
    assert.equal(first.status, 200)
    const overflow = await router('POST', `/sessions/${id}/queue`, {
      text: '再来一个',
      archives: [{ name: 'b3.zip', path: srcPath }],
    }, AUTH)
    assert.equal(overflow.status, 400)
    assert.equal((overflow.body as { code?: string }).code, 'queue_archive_budget')
  } finally { await cleanup() }
})

// ── 路由级：GET 回读 ────────────────────────────────────────────────────

test('GET /sessions/:id/documents/:docId 回读压缩包字节一致（mime=application/zip）', async () => {
  const { dir, manager, router, cleanup } = setup()
  try {
    const srcPath = makeSourceArchive(dir, 'readback.zip')
    const rec = manager.createSession({ cwd: dir })
    const sent = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: 'x', archives: [{ name: 'readback.zip', path: srcPath }],
    }, AUTH)
    assert.equal(sent.status, 200)
    const refs = lastUserEvent(manager, rec.id).data.archives as Array<{ id: string }>
    const { res, chunks, head } = fakeBinaryRes()
    const got = await router('GET', `/sessions/${rec.id}/documents/${refs[0]!.id}`, undefined, AUTH, res)
    assert.equal(got.status, 200)
    assert.deepEqual(Buffer.concat(chunks), ZIP_BYTES)
    assert.equal((head[0]!.headers as Record<string, string>)['Content-Type'], 'application/zip')
  } finally { await cleanup() }
})

// ── 幂等：同内容重发/requestId 重试落同一路径（run-ledger 指纹去重的前提） ──

test('同内容压缩包两次发送落同一路径（content-addressed），事件各自带引用', async () => {
  const { dir, manager, agents, router, cleanup } = setup()
  try {
    const srcPath = makeSourceArchive(dir, 'same.zip')
    const rec = manager.createSession({ cwd: dir })
    const first = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: '第一次', archives: [{ name: 'same.zip', path: srcPath }],
    }, AUTH)
    assert.equal(first.status, 200)
    agents[0]!.finish()
    await settle()
    const second = await router('POST', `/sessions/${rec.id}/prompt`, {
      prompt: '第二次', archives: [{ name: 'same.zip', path: srcPath }],
    }, AUTH)
    assert.equal(second.status, 200)
    const p1 = agents[0]!.runs[0]!.prompt
    const p2 = agents[0]!.runs[1]!.prompt
    const path1 = /Saved verbatim at: (.+)/.exec(p1)![1]
    const path2 = /Saved verbatim at: (.+)/.exec(p2)![1]
    assert.equal(path1, path2, '同内容应落同一路径（句柄文本字节一致 → ledger 指纹去重成立）')
    assert.deepEqual(readFileSync(path1!), ZIP_BYTES)
  } finally { await cleanup() }
})
