import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFileKind, decodeContextText, contextDataUrlBytes, isSuggestedContextFile, MAX_TEXT_ATTACHMENT_BYTES } from '../file-context-policy.js'
import { rankFiles } from '../file-list.js'

test('human files: office, markdown, scripts and source; private/binary files excluded', () => {
  for (const file of ['报告.docx', 'README.md', 'deploy.sh', 'data.csv', 'view.cs', 'Dockerfile']) assert.notEqual(contextFileKind(file), 'candidate')
  for (const file of ['app.exe', 'video.mp4', 'font.woff2', '.env', 'credentials.json', 'id_rsa']) assert.equal(contextFileKind(file), 'unsupported')
  assert.equal(contextFileKind('notes.custom'), 'candidate')
})
test('generated files hidden by default, explicit names remain searchable', () => {
  assert.equal(isSuggestedContextFile('public/app.min.js'), false)
  assert.equal(isSuggestedContextFile('public/app.min.js', 'app.min.js'), true)
  assert.equal(isSuggestedContextFile('notes.custom'), false)
  assert.equal(isSuggestedContextFile('notes.custom', 'notes.custom'), true)
  assert.equal(isSuggestedContextFile('app.exe', 'app.exe'), false)
  assert.equal(isSuggestedContextFile('pnpm-lock.yaml'), false)
})
test('ranking prioritizes documents and scripts; filename match outranks category', () => {
  assert.deepEqual(rankFiles(['a.ts', 'deploy.sh', 'report.docx', 'README.md'], ''), ['README.md', 'report.docx', 'deploy.sh', 'a.ts'])
  assert.equal(rankFiles(['docs/controller.md', 'controller.ts'], 'controller.ts')[0], 'controller.ts')
})
test('text decoding preserves Unicode/empty files, supports BOM and rejects binary/oversize', () => {
  assert.equal(decodeContextText(new TextEncoder().encode('你好\n#!/bin/sh')), '你好\n#!/bin/sh')
  assert.equal(decodeContextText(new Uint8Array()), '')
  assert.equal(decodeContextText(Uint8Array.from([0xff, 0xfe, 65, 0])), 'A')
  assert.throws(() => decodeContextText(Uint8Array.from([65, 0, 66])), /text-binary/)
  assert.throws(() => decodeContextText(Uint8Array.from([0xff, 0xab])), /text-encoding/)
  assert.throws(() => decodeContextText(new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1)), /text-too-large/)
  assert.deepEqual(contextDataUrlBytes('data:text/plain;base64,5L2g5aW9'), new TextEncoder().encode('你好'))
  assert.throws(() => contextDataUrlBytes('data:text/plain;base64,%%%%'), /attachment-data/)
})

test('Chinese legacy encodings and BOM-less UTF-16 remain readable without accepting binary', () => {
  assert.equal(decodeContextText(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 44, 49, 13, 10])), '中文,1\r\n')
  // GB18030 four-byte supplementary character U+1F600.
  assert.equal(decodeContextText(Uint8Array.from([0x94, 0x39, 0xfc, 0x36])), '😀')
  for (const be of [false, true]) {
    const bytes = new Uint8Array(Buffer.from('name,value\n中文,1', 'utf16le'))
    if (be) for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1]!, bytes[i]!]
    assert.equal(decodeContextText(bytes), 'name,value\n中文,1')
  }
  assert.throws(() => decodeContextText(Uint8Array.from([0xef, 0xbb, 0xbf, 0xd6, 0xd0])), /text-encoding/)
  assert.throws(() => decodeContextText(Uint8Array.from([0xd6, 0xd0, 0, 1])), /text-binary/)
})

test('supported archives classify as archive; other archive-ish names stay unsupported', () => {
  // 白名单：zip/tar/tgz + .tar.gz/.tar.bz2/.tar.xz（agent 侧 unzip/tar 必然可用）
  for (const name of ['a.zip', 'b.tar', 'c.tgz', 'name.tar.gz', 'name.tar.bz2', 'name.tar.xz', 'UPPER.ZIP']) {
    assert.equal(contextFileKind(name), 'archive', name)
  }
  // rar/7z/dmg 无通吃工具；单文件 gz/bz2/xz 语义歧义——维持拒收
  for (const name of ['a.rar', 'b.7z', 'c.dmg', 'foo.gz', 'foo.bz2', 'foo.xz', 'a.pkg', 'a.iso']) {
    assert.equal(contextFileKind(name), 'unsupported', name)
  }
  // 敏感名优先：.env.zip 仍 unsupported（isPrivateContextPath 先于扩展名判定）
  assert.equal(contextFileKind('.env.zip'), 'unsupported')
  // archive 不进 @ 上下文建议列表（priority 4），但显式点名仍可命中
  assert.equal(isSuggestedContextFile('icons.zip'), false)
  assert.equal(isSuggestedContextFile('icons.zip', 'icons.zip'), true)
})
