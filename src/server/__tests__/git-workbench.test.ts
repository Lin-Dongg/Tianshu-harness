import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { RuntimeSessionManager } from '../session-manager.js'
import { repositorySnapshot, history, parseStatus } from '../git-workbench.js'
import { githubRemote } from '../git-pr-service.js'

function git(cwd: string, ...args: string[]): string { return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' }) }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'git-workbench-'))
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid')
  const other = join(dir, 'other'); mkdirSync(other)
  const manager = { getDefaultCwd: () => other, listSessions: () => [{ id: 's', cwd: dir, workspaceRoots: [dir] }], getSession: (id: string) => id === 's' ? { id, cwd: dir } : undefined } as unknown as RuntimeSessionManager
  const router = createRouter(buildSessionRoutes(manager, 'test'))
  const call = (method: string, path: string, body = {}) => router(method, `/git/workbench${path}${path.includes('cwd=') ? '' : `${path.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(dir)}`}`, body, { authorization: 'Bearer test' })
  return { dir, other, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
test('real route uses explicit repository instead of default cwd and distinguishes unborn', async () => {
  const f = fixture()
  try {
    const res = await f.call('GET', '')
    assert.equal(res.status, 200)
    const result = res.body as Awaited<ReturnType<typeof repositorySnapshot>>
    assert.equal(result.repository.state, 'unborn')
    assert.notEqual(result.repository.cwd, f.other)
    const unknown = await f.call('GET', `?cwd=${encodeURIComponent(tmpdir())}`)
    assert.equal(unknown.status, 403)
    const missing = await f.call('POST', '/stage', { path: 'x' })
    assert.equal(missing.status, 409)
  } finally { f.cleanup() }
})
test('stage and commit affect only selected content; stale preview cannot commit', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, '选定 file.txt'), 'selected\n'); writeFileSync(join(f.dir, 'other.txt'), 'other\n')
    let snapshot = await repositorySnapshot(f.dir)
    const stage = await f.call('POST', '/stage', { path: '选定 file.txt', version: snapshot.repository.version })
    assert.equal(stage.status, 200)
    assert.equal(git(f.dir, 'diff', '--cached', '--name-only').trim(), '选定 file.txt')
    assert.equal((await f.call('POST', '/commit', { message: 'stale', version: snapshot.repository.version })).status, 409)
    snapshot = await repositorySnapshot(f.dir)
    const commit = await f.call('POST', '/commit', { message: 'selected', version: snapshot.repository.version })
    assert.equal(commit.status, 200)
    assert.equal(git(f.dir, 'ls-tree', '--name-only', 'HEAD').trim(), '选定 file.txt')
    assert.equal(readFileSync(join(f.dir, 'other.txt'), 'utf8'), 'other\n')
    assert.equal(git(f.dir, 'status', '--porcelain').trim(), '?? other.txt')
  } finally { f.cleanup() }
})
test('partial staging uses server diff hunk and reverse unstage preserves working file', async () => {
  const f = fixture()
  try {
    const initial = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
    writeFileSync(join(f.dir, 'file.txt'), initial); git(f.dir, 'add', 'file.txt'); git(f.dir, 'commit', '-m', 'base')
    const changed = initial.replace('line 1\n', 'change 1\n').replace('line 28\n', 'change 28\n')
    writeFileSync(join(f.dir, 'file.txt'), changed)
    let snapshot = await repositorySnapshot(f.dir)
    assert.equal((await f.call('POST', '/stage', { path: 'file.txt', hunk: 0, version: snapshot.repository.version })).status, 200)
    const index = git(f.dir, 'show', ':file.txt')
    assert.ok(index.includes('change 1')); assert.ok(!index.includes('change 28'))
    snapshot = await repositorySnapshot(f.dir)
    assert.equal((await f.call('POST', '/stage', { path: 'file.txt', hunk: 0, unstage: true, version: snapshot.repository.version })).status, 200)
    assert.equal(git(f.dir, 'show', ':file.txt'), initial)
    assert.equal(readFileSync(join(f.dir, 'file.txt'), 'utf8'), changed)
  } finally { f.cleanup() }
})
test('dirty branch switch, sensitive files and path escape fail without changing files', async () => {
  const f = fixture()
  try {
    git(f.dir, 'commit', '--allow-empty', '-m', 'base'); writeFileSync(join(f.dir, 'file.txt'), 'dirty')
    const snapshot = await repositorySnapshot(f.dir)
    assert.equal((await f.call('POST', '/branch', { name: 'dev', create: true, version: snapshot.repository.version })).status, 409)
    assert.equal(git(f.dir, 'branch', '--show-current').trim(), 'main')
    assert.equal((await f.call('GET', '/diff?path=../outside')).status, 400)
    assert.equal((await f.call('GET', '/diff?path=.env')).status, 403)
    assert.equal(readFileSync(join(f.dir, 'file.txt'), 'utf8'), 'dirty')
  } finally { f.cleanup() }
})
test('history pages commits, not ASCII connector lines', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 4; i++) git(f.dir, 'commit', '--allow-empty', '-m', `commit ${i}`)
    const first = await history(f.dir, 0, 2), second = await history(f.dir, 2, 2)
    assert.equal(first.commits.length, 2); assert.equal(first.hasMore, true)
    assert.equal(second.commits.length, 2); assert.equal(second.hasMore, false)
    assert.equal(first.commits[0]?.parents[0], first.commits[1]?.sha)
    assert.notEqual(first.commits[1]?.sha, second.commits[0]?.sha)
  } finally { f.cleanup() }
})
test('NUL status preserves tabs, newlines, rename sources and conflicts', () => {
  assert.deepEqual(parseStatus('R  new\nname\0old\tname\0UU conflict\0'), [
    { path: 'new\nname', originalPath: 'old\tname', index: 'R', worktree: ' ', conflict: false },
    { path: 'conflict', originalPath: undefined, index: 'U', worktree: 'U', conflict: true },
  ])
})
test('host/owner/repository identity distinguishes same-number PRs and enterprise hosts', () => {
  assert.deepEqual(githubRemote('git@github.com:owner/repo.git'), { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' })
  assert.equal(githubRemote('https://git.example.org/other/repo.git').host, 'git.example.org')
  assert.throws(() => githubRemote('/local/bare/repo'))
})
test('concurrent writes sharing the index reject one stale snapshot', async () => {
  const f = fixture()
  try {
    git(f.dir, 'commit', '--allow-empty', '-m', 'base')
    writeFileSync(join(f.dir, 'a.txt'), 'a'); writeFileSync(join(f.dir, 'b.txt'), 'b')
    const { repository } = await repositorySnapshot(f.dir)
    const results = await Promise.all(['a.txt', 'b.txt'].map(path => f.call('POST', '/stage', { path, version: repository.version })))
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    assert.equal(git(f.dir, 'diff', '--cached', '--name-only').trim().split('\n').length, 1)
  } finally { f.cleanup() }
})
test('hooks remain active; failed commit preserves index and unselected files', async () => {
  const f = fixture()
  try {
    git(f.dir, 'commit', '--allow-empty', '-m', 'base')
    writeFileSync(join(f.dir, 'a.txt'), 'a'); writeFileSync(join(f.dir, 'b.txt'), 'b')
    git(f.dir, 'add', 'a.txt')
    const hooks = join(f.dir, '.git', 'hooks')
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho hook-rejected >&2\nexit 1\n', { mode: 0o755 })
    const { repository } = await repositorySnapshot(f.dir)
    const result = await f.call('POST', '/commit', { message: 'blocked', version: repository.version })
    assert.equal(result.status, 422); assert.match(JSON.stringify(result.body), /hook-rejected/)
    assert.equal(git(f.dir, 'diff', '--cached', '--name-only').trim(), 'a.txt')
    assert.equal(readFileSync(join(f.dir, 'b.txt'), 'utf8'), 'b')
    assert.equal(git(f.dir, 'log', '-1', '--format=%s').trim(), 'base')
  } finally { f.cleanup() }
})
test('binary changes refuse hunk staging and allow explicit file staging', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'binary.dat'), Buffer.from([0, 1, 2])); git(f.dir, 'add', 'binary.dat'); git(f.dir, 'commit', '-m', 'base')
    writeFileSync(join(f.dir, 'binary.dat'), Buffer.from([0, 3, 4]))
    const { repository } = await repositorySnapshot(f.dir)
    assert.equal((await f.call('POST', '/stage', { path: 'binary.dat', hunk: 0, version: repository.version })).status, 400)
    assert.equal((await f.call('POST', '/stage', { path: 'binary.dat', version: repository.version })).status, 200)
    assert.equal(git(f.dir, 'diff', '--cached', '--name-only').trim(), 'binary.dat')
  } finally { f.cleanup() }
})
test('same-HEAD branch switches and remote retargeting invalidate write previews', async () => {
  const f = fixture()
  try {
    git(f.dir, 'commit', '--allow-empty', '-m', 'base'); git(f.dir, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    writeFileSync(join(f.dir, 'a.txt'), 'a')
    let version = (await repositorySnapshot(f.dir)).repository.version
    git(f.dir, 'switch', '-c', 'dev')
    assert.equal((await f.call('POST', '/stage', { path: 'a.txt', version })).status, 409)
    version = (await repositorySnapshot(f.dir)).repository.version
    git(f.dir, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git')
    assert.equal((await f.call('POST', '/stage', { path: 'a.txt', version })).status, 409)
    assert.equal(git(f.dir, 'diff', '--cached', '--name-only').trim(), '')
  } finally { f.cleanup() }
})
