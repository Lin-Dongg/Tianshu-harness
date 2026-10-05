import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { repositorySnapshot } from '../git-workbench.js'
import type { DelegateWorkerInput, RuntimeSessionManager } from '../session-manager.js'
import { delegateWorkerOnCoordinator } from '../serve-agent.js'
import { ArtifactStore } from '../../artifact/store.js'

test('real review route isolates cancelling staged/unstaged edits and passes budget to coordinator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-review-')), cwd = join(root, 'repo'), home = join(root, 'data')
  const previous = process.env.RIVET_HOME
  mkdirSync(cwd); mkdirSync(home); writeFileSync(join(home, 'config.json'), '{}'); process.env.RIVET_HOME = home
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  let input: DelegateWorkerInput | undefined, childCwd = ''
  let artifactId = ''
  const manager = {
    getDefaultCwd: () => cwd, listSessions: () => [{ id: 'parent', cwd }], getSession: (id: string) => id === 'child' ? { id, cwd: childCwd } : undefined,
    createSession: (options: { cwd: string }) => { childCwd = options.cwd; return { id: 'child', cwd: childCwd } },
    delegate: async (_id: string, request: DelegateWorkerInput) => { input = request; return { ok: true, workerId: 'worker' } },
    cancelDelegate: () => true,
    getEventsAsync: async () => ({ events: [{ type: 'delegation', data: { workerId: 'worker', status: 'completed', resultWorkOrderId: 'actual-order', artifactId } }] }),
    getWorkerLog: async (_session: string, id: string) => { assert.equal(id, 'actual-order'); return { result: { summary: 'Recovered report', evidenceStatus: 'unverified' } } },
    readArtifact: async () => null,
    listArtifacts: () => [],
  } as unknown as RuntimeSessionManager
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(cwd, 'a.txt'), 'base\n'); git('add', 'a.txt'); git('commit', '-m', 'base')
    writeFileSync(join(cwd, 'a.txt'), 'staged\n'); git('add', 'a.txt'); writeFileSync(join(cwd, 'a.txt'), 'base\n')
    writeFileSync(join(cwd, '新文件.txt'), 'untracked\n')
    const before = await repositorySnapshot(cwd)
    const router = createRouter(buildSessionRoutes(manager, 'test'))
    const response = await router('POST', '/git/workbench/review-job', { cwd, version: before.repository.version, scope: 'local', mode: 'review', maxMs: 60_000 }, { authorization: 'Bearer test' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.notEqual(childCwd, cwd)
    assert.equal(readFileSync(join(childCwd, '新文件.txt'), 'utf8'), 'untracked\n')
    assert.match(readFileSync(join(childCwd, '.rivet/git-review/staged.patch'), 'utf8'), /\+staged/)
    assert.match(readFileSync(join(childCwd, '.rivet/git-review/unstaged.patch'), 'utf8'), /-staged/)
    assert.equal((await repositorySnapshot(cwd)).repository.version, before.repository.version)
    assert.equal(input?.profile, 'reviewer'); assert.equal(input?.budget?.timeoutMs, 60_000)
    assert.match(input!.objective, /Never claim tests passed/)
    let actual: any
    const coordinator = { delegate: async (request: any) => { actual = request; return { results: [] } } }
    await delegateWorkerOnCoordinator(coordinator as any, input!, { workerId: 'worker', signal: new AbortController().signal, onActivity: () => {} })
    assert.equal(actual.budget.timeoutMs, 60_000)
    assert.equal(actual.profile, 'reviewer')
    const artifacts = new ArtifactStore(join(childCwd, '.rivet', 'artifacts'), 'worker-actual-order-nonce')
    artifactId = await artifacts.saveDurable({ tool: 'git_diff', target: 'review', rawContent: 'Recovered diff', summary: 'Diff', sections: [] })
    const loaded = await router('GET', `/git/workbench/review-job?cwd=${encodeURIComponent(cwd)}&jobId=${(response.body as any).job.id}`, {}, { authorization: 'Bearer test' })
    assert.equal(loaded.status, 200)
    assert.equal((loaded.body as any).diff, 'Recovered diff')
    assert.match((loaded.body as any).report, /unverified/)
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})
