import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { PRIVATE_PATH_ACL_SCRIPT, ensurePrivateDirectory, protectPrivatePath } from '../private-path.js'
import { privateAclAssertions, unsafeAclFixture, withoutAuditPrivilege } from './windows-acl-fixture.js'

test('private paths only persist modified DACLs, keeping owner/group/audit untouched', () => {
  assert.doesNotMatch(PRIVATE_PATH_ACL_SCRIPT, /Set-Acl|SetOwner|SetGroup|SetAuditRule|SetAuditRuleProtection/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /-notcontains \$current\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /GetSecurityDescriptorSddlForm\('Access'\) -ne \$acl\.GetSecurityDescriptorSddlForm\('Access'\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /\[IO\.Directory\]::SetAccessControl\(\$item\.FullName, \$acl\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /\[IO\.File\]::SetAccessControl\(\$item\.FullName, \$acl\)/)
})

test('Windows private-path caller sends the DACL-only script and retains failure diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-path-caller-'))
  const original = childProcess.execFileSync
  let calls = 0
  childProcess.execFileSync = ((_bin: string, args: string[], opts: any) => {
    calls++
    assert.equal(args.at(-1), PRIVATE_PATH_ACL_SCRIPT)
    assert.equal(opts.env.RIVET_PRIVATE_PATH, root)
    assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe'])
    throw new Error('native DACL write denied')
  }) as unknown as typeof childProcess.execFileSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => protectPrivatePath(root, 'win32'), /native DACL write denied/)
    assert.equal(calls, 1)
  } finally {
    childProcess.execFileSync = original
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('POSIX private directory and file modes remain restrictive', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'private-path-posix-'))
  try {
    const dir = join(root, 'data')
    ensurePrivateDirectory(dir)
    const file = join(dir, 'fixture.txt')
    writeFileSync(file, 'fixture')
    protectPrivatePath(file)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const kind of ['directory', 'file']) {
  test(`Windows private ${kind} replaces unsafe grants without SeSecurityPrivilege`, { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'private-path-native-'))
    const path = kind === 'file' ? join(root, 'fixture.txt') : root
    if (kind === 'file') writeFileSync(path, 'fixture')
    try {
      const fixture = unsafeAclFixture + withoutAuditPrivilege(`
        ${PRIVATE_PATH_ACL_SCRIPT}
        ${privateAclAssertions}
        ${PRIVATE_PATH_ACL_SCRIPT}
        if ($first.GetSecurityDescriptorSddlForm('Access') -ne (Get-Acl -LiteralPath $env:ACL_TEST_ROOT).GetSecurityDescriptorSddlForm('Access')) { throw 'Repeated protection changed the DACL' }
      `)
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      const result = childProcess.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64')], {
        env: { ...process.env, RIVET_PRIVATE_PATH: path, ACL_TEST_ROOT: path },
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
      })
      assert.equal(result.status, 0, result.stderr)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
