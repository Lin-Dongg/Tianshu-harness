import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../fetch-node-runtime.js', import.meta.url))

test('importing the shared Node version does not fetch or create runtime resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-node-import-'))
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const mod = await import(${JSON.stringify(new URL('../fetch-node-runtime.js', import.meta.url).href)}); console.log(mod.DEFAULT_NODE_VERSION)`], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '24.18.0')
    assert.equal(existsSync(join(root, 'out')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI fetch entry reuses a complete cached Node payload without desktop source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-node-cache-'))
  try {
    const token = process.platform === 'win32' ? 'win' : process.platform
    const payload = join(root, `${token}-${process.arch}`)
    mkdirSync(payload)
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    cpSync(process.execPath, join(payload, nodeName))
    writeFileSync(join(payload, '.node-version'), process.versions.node)
    const result = spawnSync(process.execPath, [script, root], { env: { ...process.env, NODE_VERSION: process.versions.node, TAURI_ENV_TARGET_TRIPLE: '' }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const probe = spawnSync(join(payload, nodeName), ['-p', 'process.versions.node'], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    assert.equal(probe.stdout.trim(), process.versions.node)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
