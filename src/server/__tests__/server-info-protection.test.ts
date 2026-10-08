import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeServerInfo, readServerInfo, type ServerInfo } from '../server-info.js'
import { ensurePrivateDirectory, PRIVATE_PATH_ACL_SCRIPT } from '../../platform/private-path.js'

const info: ServerInfo = { host: '127.0.0.1', port: 3100, pid: 1, token: 'fixture-only', startedAt: 'now' }

test('discovery protects an empty unique file before writing credential bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'info-private-')), path = join(dir, 'server-info.json')
  try {
    let protectedEmpty = false
    writeServerInfo(info, path, { ensurePrivateDirectory, protectPrivatePath: temporary => {
      assert.equal(readFileSync(temporary, 'utf8'), '')
      assert.equal(existsSync(path), false)
      protectedEmpty = true
    } })
    assert.equal(protectedEmpty, true)
    assert.deepEqual(readServerInfo(path), info)
    assert.deepEqual(readdirSync(dir), ['server-info.json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ACL failure cannot publish plaintext or leave a credential-bearing temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'info-acl-denied-')), path = join(dir, 'server-info.json')
  try {
    writeServerInfo(info, path, { ensurePrivateDirectory, protectPrivatePath: () => { throw new Error('ACL denied') } })
    assert.equal(existsSync(path), false)
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Windows private ACL replaces all explicit and inherited grants with owner/SYSTEM/admin only', () => {
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /New-Object Security.AccessControl.DirectorySecurity/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /ReparsePoint/)
  assert.doesNotMatch(PRIVATE_PATH_ACL_SCRIPT, /S-1-5-11|S-1-5-32-545|grant:r/)
})
