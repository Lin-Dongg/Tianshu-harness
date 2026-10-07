/**
 * Issue #358 — a session cwd is not the boundary of the work. An agent may
 * write a deliverable outside the workspace (a staging area, a handoff dir);
 * that absolute path enters the session file history, and the Changes view
 * still has to render it. Before the fix both helpers threw `无效文件路径`
 * for any path outside cwd, and the three routes calling them had no catch —
 * the client saw a bare 500 and the file rendered empty.
 *
 * Anti-proof table:
 *   #1 "files outside cwd are undiffable" → test 1 diffs a real temp dir that
 *      lives outside the session cwd and asserts both the added lines and the
 *      header path the desktop parser anchors on.
 *   #2 "the route degrades to a bare 500" → test 2 asserts a structured 400
 *      for the rejected (relative-escape) shape on all three routes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class NoopAgent implements ManagedAgent {
  run(_prompt: string): Promise<void> { return Promise.resolve() }
  finish(): void {}
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  callbacks(_cb: Partial<AgentCallbacks>): void {}
}

/** A git repo with one commit — stands in for the session cwd. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-358-inside-'))
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' })
  return dir
}

test('#1 GET /git/diff renders an absolute path outside the session cwd', async () => {
  const inside = initRepo()
  const outside = mkdtempSync(join(tmpdir(), 'rivet-358-outside-'))
  try {
    const reportPath = join(outside, 'report.md')
    writeFileSync(reportPath, 'staged output\n')
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent(), defaultCwd: inside })
    const router = createRouter(buildSessionRoutes(manager, TOKEN))
    const res = await router('GET', `/git/diff?path=${encodeURIComponent(reportPath)}`, {}, AUTH)
    assert.equal(res.status, 200)
    const diff = (res.body as { diff: string }).diff
    assert.ok(diff.includes('+staged output'), `outside file should render as an addition:\n${diff}`)
    assert.ok(diff.includes(`+++ b/${reportPath}`), `header should anchor on the requested path:\n${diff}`)
  } finally {
    rmSync(inside, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('#2 a rejected path answers 400 on every diff route, never an unhandled 500', async () => {
  const inside = initRepo()
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent(), defaultCwd: inside })
    const router = createRouter(buildSessionRoutes(manager, TOKEN))
    const created = await router('POST', '/sessions', { title: 'T' }, AUTH)
    const id = (created.body as { id: string }).id
    const escape = encodeURIComponent('../escape.md')
    for (const route of ['/git/diff', `/sessions/${id}/git/diff`, `/sessions/${id}/git/file-base`]) {
      const res = await router('GET', `${route}?path=${escape}`, {}, AUTH)
      assert.equal(res.status, 400, `${route} should reject the traversal shape with 400`)
      assert.match((res.body as { error: string }).error, /无效文件路径/)
    }
  } finally { rmSync(inside, { recursive: true, force: true }) }
})

test('#3 the session-scoped routes serve a file outside the session cwd', async () => {
  const inside = initRepo()
  const outside = mkdtempSync(join(tmpdir(), 'rivet-358-outside2-'))
  try {
    const reportPath = join(outside, 'report.md')
    writeFileSync(reportPath, 'handoff\n')
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent(), defaultCwd: inside })
    const router = createRouter(buildSessionRoutes(manager, TOKEN))
    const created = await router('POST', '/sessions', { title: 'T' }, AUTH)
    const id = (created.body as { id: string }).id

    const diff = await router('GET', `/sessions/${id}/git/diff?path=${encodeURIComponent(reportPath)}`, {}, AUTH)
    assert.equal(diff.status, 200)
    assert.ok((diff.body as { diff: string }).diff.includes('+handoff'))

    const base = await router('GET', `/sessions/${id}/git/file-base?path=${encodeURIComponent(reportPath)}`, {}, AUTH)
    assert.equal(base.status, 200)
    assert.deepEqual(base.body, { exists: false, content: '' })
  } finally {
    rmSync(inside, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// serveFileRoute maps three outcomes; test #1/#3 pin the 200 arm and test #2 the
// 400 arm. The 404 arm (unknown session) has its own semantics: the path is
// valid, there is simply nothing to resolve it against — it must not collapse
// into a 400 or escape to the server-level 500 fallback.
test('#4 an unknown session answers 404 on both session-scoped routes', async () => {
  const inside = initRepo()
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent(), defaultCwd: inside })
    const router = createRouter(buildSessionRoutes(manager, TOKEN))
    const path = encodeURIComponent(join(inside, 'base.txt'))
    for (const route of ['/sessions/nope/git/diff', '/sessions/nope/git/file-base']) {
      const res = await router('GET', `${route}?path=${path}`, {}, AUTH)
      assert.equal(res.status, 404, `${route} should answer 404 for an unknown session`)
      assert.match((res.body as { error: string }).error, /Session not found/)
    }
  } finally { rmSync(inside, { recursive: true, force: true }) }
})
