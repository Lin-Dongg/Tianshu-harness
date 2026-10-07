import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../bash.js'
import { SessionJobs } from '../job-store.js'
import { prepareCompletionCapture } from '../test-completion.js'
import { splitVerificationRedirection } from '../verification-redirection.js'
import { buildBashVerification } from '../../agent/bash-verification.js'
import type { VerificationMetadata } from '../types.js'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'verification-redirect-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }))
  writeFileSync(join(cwd, 'good.test.mjs'), "import {test} from 'node:test';test('yes',()=>{});")
  writeFileSync(join(cwd, 'bad.test.mjs'), "import {test} from 'node:test';test('no',()=>{throw Error('red');});")
  return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}

it('literal redirection retains foreground proof and writes the requested log', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  try {
    const command = "node --test good.test.mjs > 'test output.log' 2>&1"
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'redirect-front', input: { command } })
    const proof = buildBashVerification(command, result, { content: result.content, isError: !!result.isError })
    assert.equal(proof.coverage?.complete, true)
    assert.deepEqual(proof.coverage?.files.map(file => file.path), ['good.test.mjs'])
    assert.equal(proof.status, 'passed')
    assert.equal(proof.scope, 'targeted')
    assert.match(readFileSync(join(f.cwd, 'test output.log'), 'utf8'), /yes/)
  } finally { f.dispose() }
})

it('literal append redirection retains failed background evidence and records exactly once', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(), logs = mkdtempSync(join(tmpdir(), 'redirect-jobs-')), jobs = new SessionJobs(logs)
  try {
    const records: VerificationMetadata[] = []
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'redirect-bg', input: { command: 'node --test bad.test.mjs >> test.log 2>&1', run_in_background: true }, jobs, onVerificationCompleted: proof => records.push(proof) })
    await jobs.await(result.backgroundJobId!, { timeoutMs: 10000 })
    assert.equal(records.length, 1)
    assert.equal(records[0]?.exitCode, 1)
    assert.equal(records[0]?.status, 'failed')
    assert.equal(records[0]?.coverage?.executionComplete, true)
    assert.equal(records[0]?.coverage?.complete, false)
    assert.equal(records[0]?.failed, 1)
    await jobs.await(result.backgroundJobId!, { timeoutMs: 1 })
    assert.equal(records.length, 1)
  } finally { jobs.killAll(); f.dispose(); rmSync(logs, { recursive: true, force: true }) }
})

it('a completed background proof does not retain the missing-proof guidance', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(), logs = mkdtempSync(join(tmpdir(), 'redirect-guidance-')), jobs = new SessionJobs(logs)
  try {
    const records: VerificationMetadata[] = []
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'redirect-guidance', input: { command: 'node --test good.test.mjs > test.log 2>&1', run_in_background: true }, jobs, onVerificationCompleted: proof => records.push(proof) })
    await jobs.await(result.backgroundJobId!, { timeoutMs: 10000 })
    assert.equal(records[0]?.coverage?.complete, true)
    assert.equal(records[0]?.userGuidance, undefined)
  } finally { jobs.killAll(); f.dispose(); rmSync(logs, { recursive: true, force: true }) }
})

it('literal cd and shell wrappers retain redirect destinations and repository-relative proof', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  try {
    const command = `bash -c 'cd -- "${f.cwd}" && node --test good.test.mjs > test.log 2>&1'`
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'redirect-wrapper', input: { command } })
    assert.equal(result.verification?.coverage?.complete, true)
    assert.deepEqual(result.verification?.coverage?.files.map(file => file.path), ['good.test.mjs'])
    assert.match(readFileSync(join(f.cwd, 'test.log'), 'utf8'), /yes/)
  } finally { f.dispose() }
})

it('unsupported shell shapes and other shell families never acquire capture', () => {
  const f = fixture()
  try {
    for (const command of [
      'false && node --test good.test.mjs > test.log',
      'node --test bad.test.mjs > test.log; echo ok',
      'node --test good.test.mjs; node --test bad.test.mjs',
      'node --test good.test.mjs > test.log | tail -5',
      'node --test good.test.mjs > "$LOG"',
      'node --test good.test.mjs 3> test.log',
      'node --test good.test.mjs > test.log extra',
      'node --test --test-name-pattern yes good.test.mjs > test.log',
      'node --test good.test.mjs < input > test.log',
    ]) assert.equal(prepareCompletionCapture(command, f.cwd), undefined, command)
    for (const shell of ['cmd', 'powershell'] as const) assert.equal(prepareCompletionCapture('node --test good.test.mjs > test.log', f.cwd, shell), undefined)
    assert.equal(splitVerificationRedirection('node --test good.test.mjs >'), undefined)
    assert.equal(splitVerificationRedirection('node --test good.test.mjs 3> test.log'), undefined)
  } finally { f.dispose() }
})

it('a failed validator followed by a successful echo remains without passed coverage', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  try {
    const command = 'node --test bad.test.mjs > test.log 2>&1; echo ok'
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'masked-exit', input: { command } })
    assert.equal(result.exitCode, 0)
    const proof = buildBashVerification(command, result, { content: result.content, isError: !!result.isError })
    assert.notEqual(proof.status, 'passed')
    assert.equal(proof.coverage, undefined)
  } finally { f.dispose() }
})
