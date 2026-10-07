import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOmittedDirtyPaths } from '../verification-snapshot-manager.js'

/**
 * 快照只重放 owned（本会话**工具写入**）的文件；经 bash 脚本改的文件不在其中
 * （2026-10-06 实测：快照内 src/config/env-registry.ts 仍是 HEAD 版、工作树已改）。
 * 这会让「隔离红」看起来像代码缺陷，而真实原因可能只是快照缺改动——所以要把
 * 差集挑出来点名（fail loud 而非静默误导）。
 */
test('parseOmittedDirtyPaths 挑出 dirty 但不在 owned 内的文件', () => {
  const status = [
    ' M src/config/env-registry.ts', // bash 生成器改的 → 漏
    ' M src/tools/syntax-check.ts', // 工具写的 → 已 owned
    '?? src/agent/new-file.ts', // 新增且未 owned → 漏
    ' M desktop/src/App.tsx', // 别的会话改的 → 如实列出（本会话不知道它）
  ].join('\n')
  assert.deepEqual(parseOmittedDirtyPaths(status, ['/repo/src/tools/syntax-check.ts']), [
    'src/config/env-registry.ts',
    'src/agent/new-file.ts',
    'desktop/src/App.tsx',
  ])
})

test('owned 路径形态差异（绝对 / 相对 / ./ 前缀）都能对上', () => {
  const status = ' M src/a.ts\n M src/b.ts'
  assert.deepEqual(parseOmittedDirtyPaths(status, ['src/a.ts', './src/b.ts']), [])
})

test('rename 取新路径；空输出与垃圾行不炸', () => {
  assert.deepEqual(parseOmittedDirtyPaths('R  src/old.ts -> src/new.ts', ['src/new.ts']), [])
  assert.deepEqual(parseOmittedDirtyPaths('', []), [])
  assert.deepEqual(parseOmittedDirtyPaths('\n\n', []), [])
})

test('上限 20 条（避免把阶段 A 提示撑爆）', () => {
  const many = Array.from({ length: 30 }, (_, i) => ` M src/f${i}.ts`).join('\n')
  assert.equal(parseOmittedDirtyPaths(many, []).length, 20)
})
