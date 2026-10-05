/**
 * POST /sessions 携带文档附件（欢迎页按钮/拖拽/粘贴，2026-09-12）——
 * 与 /prompt 同一份 validateDocumentsPayload 校验与 extractDocumentsToText
 * 抽取管线：抽取文本前置进首轮 prompt。此前 POST /sessions 没有该管线，
 * 欢迎页附件只能「建会话后再发」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type SessionPersistenceAdapter,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  runPrompts: string[] = []
  private resolveRun?: () => void
  run(p: string, cb: AgentCallbacks) {
    this.runPrompts.push(p)
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

type Router = ReturnType<typeof setup>['router']

/** 最小合法 xlsx（exceljs 现场构建，纯 JS 无系统依赖）。 */
async function makeXlsxDataUrl(marker: string): Promise<string> {
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S1')
  ws.getCell('A1').value = marker
  const buf = await wb.xlsx.writeBuffer()
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${Buffer.from(buf as ArrayBuffer).toString('base64')}`
}

const PDF_DOC = { name: 'spec.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' }

test('plain text attachments reach the real create/prompt consumer and echo cards', async () => {
  const { agents, router, manager } = setup()
  const content = '中文需求\n#!/bin/sh\necho hello'
  const documents = [{ name: '需求.md', dataUrl: `data:text/plain;base64,${Buffer.from(content).toString('base64')}` }]
  const created = await router('POST', '/sessions', { prompt: '分析附件', documents }, AUTH)
  assert.equal(created.status, 201)
  assert.ok(agents[0]!.runPrompts[0]!.includes(content))
  const rec = created.body as { id: string }
  const user = manager.getEvents(rec.id)!.events.find(event => event.type === 'user')!
  assert.equal(user!.data.promptText, '分析附件')
  assert.equal((user!.data.documents as Array<{ name: string }>)[0]?.name, '需求.md')
  const separate = manager.createSession({ cwd: '/tmp/work' })
  const sent = await router('POST', `/sessions/${separate.id}/prompt`, { prompt: '读脚本', documents: [{ ...documents[0]!, name: 'deploy.sh' }] }, AUTH)
  assert.equal(sent.status, 200)
  assert.ok(agents[1]!.runPrompts[0]!.includes(content))
})

test('plain text attachment validation rejects binary bytes, bad encoding and oversized input', async () => {
  const { router } = setup()
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xaa]), Buffer.alloc(512 * 1024 + 1, 65)]) {
    const res = await router('POST', '/sessions', { prompt: 'read', documents: [{ name: 'script.sh', dataUrl: `data:text/plain;base64,${bytes.toString('base64')}` }] }, AUTH)
    assert.equal(res.status, 400)
  }
  const res = await router('POST', '/sessions', { prompt: 'read', documents: [{ name: 'fake.exe', dataUrl: 'data:text/plain;base64,aGk=' }] }, AUTH)
  assert.equal(res.status, 400)
})

test('POST /sessions documents 校验：空数组 / 超上限 / 形态错误 / 超尺寸 → 400', async () => {
  const { router } = setup()
  const create = (documents: unknown) => router('POST', '/sessions', { prompt: 'x', documents }, AUTH)

  let res = await create([])
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /non-empty array/)

  res = await create(Array.from({ length: 5 }, (_, i) => ({ name: `d${i}.pdf`, dataUrl: PDF_DOC.dataUrl })))
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /Max 4/)

  res = await create([{ name: 'd.pdf' }])
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /name: string, dataUrl: string/)

  const huge = `data:application/pdf;base64,${'A'.repeat(11 * 1024 * 1024)}`
  res = await create([{ name: 'big.pdf', dataUrl: huge }])
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /<= 8MB/)
})

test('documents 扩展名白名单：非可抽取类型拒收（与 doc-extract 的 EXTRACTABLE 对齐）', async () => {
  // 此前只校验数量/字段类型/字节数——任意扩展名都能过服务端、落盘并交给抽取器。
  // 同一文件的图片路径有 ACCEPTED_IMAGE_DATA_URL 正则把关，documents 没有；
  // 白名单取 doc-extract 的 EXTRACTABLE（能抽取才放行），两侧守卫对称。
  const { router } = setup()
  const create = (documents: unknown) => router('POST', '/sessions', { prompt: 'x', documents }, AUTH)

  let res = await create([{ name: 'evil.exe', dataUrl: PDF_DOC.dataUrl }])
  assert.equal(res.status, 400, '非可抽取扩展名应被拒')
  assert.match((res.body as { error: string }).error, /extractable/i)

  res = await create([{ name: 'noext', dataUrl: PDF_DOC.dataUrl }])
  assert.equal(res.status, 400, '无扩展名应被拒')

  res = await create([{ name: 'FORMULA.XLSX', dataUrl: PDF_DOC.dataUrl }])
  assert.equal(res.status, 201, '白名单应大小写不敏感地放行可抽取类型')
})

test('POST /sessions 携带 xlsx → 201 且首轮 prompt 含抽取文本（欢迎页文档链路）', async () => {
  const { agents, router } = setup()
  const marker = `welcome-doc-${Date.now()}`
  const dataUrl = await makeXlsxDataUrl(marker)
  const res = await router('POST', '/sessions', {
    prompt: '看下这份表',
    documents: [{ name: 'report.xlsx', dataUrl }],
  }, AUTH)
  assert.equal(res.status, 201)
  assert.equal(agents.length, 1)
  assert.equal(agents[0]!.runPrompts.length, 1)
  assert.ok(agents[0]!.runPrompts[0]!.includes(marker), '抽取的表格文本应前置进首轮 prompt')
  assert.ok(agents[0]!.runPrompts[0]!.includes('看下这份表'), '用户 prompt 本体保留')
})

test('POST /sessions 文档抽取失败（伪 pdf）不阻断创建——降级为失败标注进 prompt', async () => {
  const { agents, router } = setup()
  const res = await router('POST', '/sessions', {
    prompt: 'analyze this',
    documents: [PDF_DOC],
  }, AUTH)
  assert.equal(res.status, 201)
  assert.equal(agents.length, 1)
  // 抽取失败不静默：prompt 带 [document] 标注与失败原因（agent 知道附件存在及为何没内容）
  const p = agents[0]!.runPrompts[0]!
  assert.ok(p.includes('[document: spec.pdf]'), '应带文档标注')
  assert.ok(p.includes('extraction failed'), '应声明抽取失败')
  assert.ok(p.endsWith('analyze this'), '用户 prompt 本体保留在尾部')
})

test('POST /sessions 不带 documents → 行为不变（回归）', async () => {
  const { agents, router } = setup()
  const res = await router('POST', '/sessions', { prompt: 'plain' }, AUTH)
  assert.equal(res.status, 201)
  assert.equal(agents[0]!.runPrompts[0], 'plain')
})

test('POST /sessions/:id/prompt documents 校验走同一 helper（重构回归）', async () => {
  const { router, manager } = setup()
  const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
  const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: 'x', documents: [] }, AUTH)
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /non-empty array/)
})

// ── issue #300：附件卡片元数据 + 原文持久化回读 ──────────────────────────

class MemDocPersistence implements SessionPersistenceAdapter {
  docs = new Map<string, { bytes: Buffer; mime: string; ext: string }>()
  saveRecord(): void {}
  loadAll() { return [] }
  appendEvent(): void {}
  saveDocument(sessionId: string, docId: string, base64: string, fileName: string): void {
    this.docs.set(`${sessionId}/${docId}`, { bytes: Buffer.from(base64, 'base64'), mime: 'application/pdf', ext: fileName.split('.').pop() ?? 'bin' })
  }
  readDocument(sessionId: string, docId: string) {
    return this.docs.get(`${sessionId}/${docId}`)
  }
}

function setupWithPersistence() {
  const persistence = new MemDocPersistence()
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    persistence,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router, persistence }
}

test('issue #300：/prompt 携带文档 → user 事件带 documents 引用 + promptText，text 保持模型可见全文', async () => {
  const { manager, router } = setupWithPersistence()
  const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
  const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: '总结这份文档', documents: [PDF_DOC] }, AUTH)
  assert.equal(res.status, 200)

  const user = manager.getEvents(rec.id, 0)!.events.find((e) => e.type === 'user')!
  const docs = user.data.documents as Array<{ id: string; name: string; bytes: number; mime: string }>
  assert.equal(docs.length, 1, 'user 事件必须携带文档引用元数据')
  assert.equal(docs[0]!.name, 'spec.pdf')
  assert.equal(docs[0]!.mime, 'application/pdf')
  assert.ok(docs[0]!.bytes > 0, 'bytes 由服务端解码自算')
  assert.equal(user.data.promptText, '总结这份文档', 'UI 据此渲染用户原文而非拼接全文')
  assert.ok(String(user.data.text).includes('[document: spec.pdf]'), 'text 仍是模型可见全文（含抽取块）')
  assert.ok(!('dataUrl' in docs[0]!), '事件流不得携带 base64 原文')
})

test('issue #300：文档原文可经 GET /sessions/:id/documents/:docId 回读（字节级一致）', async () => {
  const { manager, router } = setupWithPersistence()
  const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
  const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: 'x', documents: [PDF_DOC] }, AUTH)
  assert.equal(res.status, 200)

  const user = manager.getEvents(rec.id, 0)!.events.find((e) => e.type === 'user')!
  const docId = (user.data.documents as Array<{ id: string }>)[0]!.id
  const got = manager.readDocument(rec.id, docId)
  assert.ok(got, '原文必须可读回')
  assert.deepEqual(got!.bytes, Buffer.from(PDF_DOC.dataUrl.split(',')[1]!, 'base64'))
  assert.equal(got!.mime, 'application/pdf')
})

test('issue #300：不带 documents 的 user 事件不出现新字段（回归）', async () => {
  const { manager, router } = setup()
  const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
  await router('POST', `/sessions/${rec.id}/prompt`, { prompt: 'plain' }, AUTH)
  const user = manager.getEvents(rec.id, 0)!.events.find((e) => e.type === 'user')!
  assert.equal(user.data.documents, undefined)
  assert.equal(user.data.promptText, undefined)
})

test('issue #300：PDF 附件 + 无 vision 通路 → 不尝试页图、run 正常携带原文元数据', async () => {
  const { manager, agents, router } = setupWithPersistence()
  const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
  const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: '看图', documents: [PDF_DOC] }, AUTH)
  assert.equal(res.status, 200)
  // FakeAgent 无 getVisionBridge → 页图通道关闭；run 正常启动且不带图片
  assert.equal(agents.length, 1)
  const user = manager.getEvents(rec.id, 0)!.events.find((e) => e.type === 'user')!
  assert.equal((user.data.documents as unknown[]).length, 1)
  assert.equal(user.data.imageIds, undefined)
})


test('welcome create and session prompt both decode legacy TXT/CSV and extract zipped Office attachments', async () => {
  const { default: JSZip } = await import('jszip')
  const { agents, router, manager } = setup()
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>shared-office-marker</a:t></a:r></a:p></p:sld>')
  const documents = [
    { name: 'gbk.txt', dataUrl: `data:text/plain;base64,${Buffer.from([0xd6,0xd0,0xce,0xc4]).toString('base64')}` },
    { name: 'excel.csv', dataUrl: `data:text/plain;base64,${Buffer.from('name,value\n中文,1', 'utf16le').toString('base64')}` },
    { name: 'deck.pptx', dataUrl: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${(await zip.generateAsync({type:'nodebuffer'})).toString('base64')}` },
  ]
  try {
    const created = await router('POST', '/sessions', { prompt: 'read', documents }, AUTH)
    assert.equal(created.status, 201)
    const next = manager.createSession({ cwd: '/tmp/work' })
    const sent = await router('POST', `/sessions/${next.id}/prompt`, { prompt: 'read', documents }, AUTH)
    assert.equal(sent.status, 200)
    for (const agent of agents) {
      assert.match(agent.runPrompts[0]!, /中文/)
      assert.match(agent.runPrompts[0]!, /name,value\n中文,1/)
      assert.match(agent.runPrompts[0]!, /shared-office-marker/)
      assert.ok(!agent.runPrompts[0]!.includes('extraction failed'))
    }
  } finally { await manager.shutdownAll() }
})
