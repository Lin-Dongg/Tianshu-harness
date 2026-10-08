/**
 * 回归测试：钉住 2026-10-08 首次真跑 AtomGit 发布时暴露的三处平台适配。
 *
 * 三个断言的共同点：**都不依赖网络**，靠注入 request（脚本本来就留了这个接缝），
 * 所以能用假响应精确复现平台行为，并在实现回退时立刻变红。
 *
 *   1. 上传必须显式带 Content-Length —— 预签名端点对 chunked PUT 返 411 Length Required
 *   2. 存在性探测不得用 HEAD —— AtomGit 附件入口对 HEAD 恒 404（同一 URL 的 GET 正常 206），
 *      用 HEAD 判存会把已上传的附件判成「不存在」，每次重跑都重传几百 MB
 *   3. 验收不得把 HEAD 404 当失败 —— 以 Range 206 为准，HEAD 只作记录
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uploadImmutable, verifyDownload } from './publish-atomgit.mjs'

const BODY = Buffer.from('atomgit attachment body\n')
const SHA = createHash('sha256').update(BODY).digest('hex')
const EXPECTED = { size: BODY.length, sha256: SHA }

/** 假平台：existing 控制附件是否已存在；headStatus 模拟 AtomGit 对 HEAD 恒 404。 */
function makeHarness({ existing, headStatus = 404 } = {}) {
  const calls = { put: 0, head: 0, probe: 0, download: 0, putHeaders: undefined, probeMethod: undefined }
  const request = async (_url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const range = opts.headers?.Range
    if (method === 'PUT') {
      calls.put += 1
      calls.putHeaders = opts.headers
      return new Response('success', { status: 200 })
    }
    if (method === 'HEAD') {
      calls.head += 1
      return new Response(null, { status: headStatus })
    }
    if (range === 'bytes=0-0') {
      calls.probe += 1
      calls.probeMethod = method
      return existing
        ? new Response(BODY.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${BODY.length}` } })
        : new Response(null, { status: 404 })
    }
    if (range === 'bytes=0-1023') {
      return new Response(BODY, { status: 206, headers: { 'content-range': `bytes 0-1023/${BODY.length}` } })
    }
    calls.download += 1
    return new Response(BODY, { status: 200 })
  }
  return { request, calls }
}

function makeFile() {
  const dir = mkdtempSync(join(tmpdir(), 'atomgit-publish-'))
  const file = join(dir, 'artifact.bin')
  writeFileSync(file, BODY)
  return file
}

test('上传显式带 Content-Length（chunked PUT 会被预签名端点以 411 拒收）', async () => {
  const file = makeFile()
  const { request, calls } = makeHarness({ existing: false })
  const api = async () => ({ url: 'https://upload.example.test/put', headers: { 'Content-Type': 'application/octet-stream' } })

  await uploadImmutable(api, 'v0.0.0', file, EXPECTED, request)

  assert.equal(calls.put, 1, '应当发生一次上传')
  assert.equal(
    calls.putHeaders?.['Content-Length'],
    String(BODY.length),
    'PUT 必须携带真实长度——缺了就是 411',
  )
})

test('存在性探测用 Range GET 而非 HEAD（HEAD 恒 404 会误判为不存在并重复上传）', async () => {
  const file = makeFile()
  const { request, calls } = makeHarness({ existing: true, headStatus: 404 })
  const api = async () => { throw new Error('附件已存在，不应再取 upload_url') }

  await uploadImmutable(api, 'v0.0.0', file, EXPECTED, request)

  assert.equal(calls.probe, 1, '存在性探测应发生一次')
  assert.equal(calls.probeMethod, 'GET', '探测方法必须是 GET（HEAD 恒 404）')
  assert.equal(calls.put, 0, '已存在时不得重复上传')
})

test('HEAD 恒 404 不影响验收——以 Range 206 为准，HEAD 只作记录', async () => {
  const { request } = makeHarness({ existing: true, headStatus: 404 })

  const proof = await verifyDownload('https://api.example.test/attach/download', EXPECTED, request)

  assert.equal(proof.headStatus, 404, '平台对 HEAD 恒 404（事实记录，不是失败）')
  assert.equal(proof.rangeSupported, true, 'Range 206 + content-range 才是验收依据')
  assert.equal(proof.sha256, SHA, '全量内容的 SHA-256 必须与本地一致')
})
