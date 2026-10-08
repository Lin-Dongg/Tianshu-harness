import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// scripts/releases/ -> 仓库根
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = 'scripts/releases/publish-release-catalog.sh'
const run = args => spawnSync('bash', [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })

test('publish-release-catalog.sh 语法正确', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('未知参数以退出码 2 拒绝（不静默吞掉）', () => {
  const r = run(['--nope'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知参数/)
})

// 核心安全不变量：默认（无 --publish）只做前置检查 + 本地生成，绝不触碰线上。
// 脚本改坏了对外发布门禁时，这条会红。
test('默认模式绝不进入对外发布步骤', () => {
  const r = run([])
  assert.ok(!r.stdout.includes('4/4 发布 catalog'), '默认模式不应进入发布步骤')
  assert.ok(!r.stdout.includes('publish-routing.mjs --publish'), '默认模式不应发布 catalog')
  assert.ok(!r.stdout.includes('--release-notes-reviewed'), '默认模式不应调用 publish-routing')
})

// 前置不齐必须 fail-closed（非 0 退出 + 明确提示），齐备则停在 DRY RUN——两种情况都不得对外发布。
test('前置检查 fail-closed：不齐则非 0 退出，齐则停在 DRY RUN', () => {
  const r = run([])
  if (r.status === 0) {
    assert.match(r.stdout, /DRY RUN/)
  } else {
    assert.equal(r.status, 1)
    assert.match(r.stderr, /✗/)
  }
})
