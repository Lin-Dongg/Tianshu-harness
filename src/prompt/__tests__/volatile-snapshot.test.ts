import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVolatileSnapshot } from '../volatile-snapshot.js'

describe('createVolatileSnapshot', () => {
  it('captures gitStatus at creation time and freezes it', () => {
    let currentGit = 'M src/foo.ts'
    const getGit = () => currentGit

    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: getGit,
    })

    assert.equal(snapshot.gitStatus, 'M src/foo.ts')

    // Simulate git status changing after snapshot
    currentGit = 'M src/foo.ts\nM src/bar.ts'
    assert.equal(snapshot.gitStatus, 'M src/foo.ts', 'snapshot should not change')
  })

  it('returns frozen object (immutable)', () => {
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: () => 'clean',
    })

    assert.throws(() => {
      ;(snapshot as any).cwd = '/changed'
    }, TypeError)
  })

  it('handles undefined git status gracefully', () => {
    const snapshot = createVolatileSnapshot({ cwd: '/nonexistent' })
    assert.equal(snapshot.gitStatus, undefined)
  })

  it('copies workingSet array to prevent external mutation', () => {
    const files = ['src/a.ts']
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: () => undefined,
      workingSet: files,
    })

    files.push('src/b.ts')
    assert.deepEqual(snapshot.workingSet, ['src/a.ts'], 'snapshot workingSet should not be affected by external mutation')
  })

  it('freezes workingSet array contents', () => {
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: () => undefined,
      workingSet: ['src/a.ts'],
    })

    assert.throws(() => {
      ;(snapshot.workingSet as any).push('src/b.ts')
    }, TypeError)
  })

  it('preserves activeDomain when provided', () => {
    const domain = { name: 'test', volatileBlock: 'block', motto: 'motto' }
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      activeDomain: domain,
    })

    assert.deepEqual(snapshot.activeDomain, domain)
  })

  it('sets activeDomain to undefined when not provided', () => {
    const snapshot = createVolatileSnapshot({ cwd: '/test' })
    assert.equal(snapshot.activeDomain, undefined)
  })

  it('preserves sessionMemoryBlock', () => {
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      sessionMemoryBlock: 'remember this',
    })
    assert.equal(snapshot.sessionMemoryBlock, 'remember this')
  })

  it('does not snapshot project knowledge files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'volatile-snapshot-knowledge-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(join(knowledgeDir, 'project-memory.md'), '### Memory\nDo not inject me.\n', 'utf-8')

      const snapshot = createVolatileSnapshot({ cwd })

      assert.equal('_knowledgeSnapshot' in snapshot, false)
      assert.equal(JSON.stringify(snapshot).includes('Do not inject me'), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('project trust gate for .rivet state injection (memory/manifest, 2026-10-03 安全报告)', () => {
  const prevTrust = process.env.RIVET_TRUST_PROJECT
  const prevHome = process.env.RIVET_HOME
  const tmpDirs: string[] = []

  // 武器形状与 2026-10-03 报告第 2/3 节一致：Tier-1 kind + confidence ≥ 0.95 的记忆条目，
  // 以及带 load_when 触发词的 manifest 索引。两处都无 AGENTS.md——状态文件单独构成注入面。
  function tmpProjectWithState(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-state-gate-'))
    const knowledgeDir = join(dir, '.rivet', 'knowledge')
    mkdirSync(knowledgeDir, { recursive: true })
    writeFileSync(join(knowledgeDir, 'memory.jsonl'), JSON.stringify({
      id: 'mem_gate_test', kind: 'user_constraint', text: 'STATE_MEMORY_SENTINEL',
      confidence: 1.0, createdAt: 1, source: 'consolidation',
    }) + '\n')
    writeFileSync(join(knowledgeDir, 'manifest.md'), '### docs/x.md\n- load_when: STATE_MANIFEST_SENTINEL trigger\n')
    tmpDirs.push(dir)
    return dir
  }

  function isolateHome(): void {
    // 隔离 home，避免触碰真实 ~/.rivet（与 project-trust.test.ts 同纪律）。
    const home = mkdtempSync(join(tmpdir(), 'rivet-state-gate-home-'))
    tmpDirs.push(home)
    process.env.RIVET_HOME = home
  }

  afterEach(() => {
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('does NOT inject memory.jsonl / manifest.md from an untrusted project dir', () => {
    const cwd = tmpProjectWithState()
    isolateHome()
    process.env.RIVET_TRUST_PROJECT = '0'
    const snapshot = createVolatileSnapshot({ cwd, getGitStatus: () => undefined })
    assert.equal(snapshot.projectMemoryBlock, undefined)
    assert.equal(snapshot.knowledgeManifestBlock, undefined)
  })

  it('injects memory.jsonl / manifest.md from a trusted project dir', () => {
    const cwd = tmpProjectWithState()
    isolateHome()
    process.env.RIVET_TRUST_PROJECT = '1'
    const snapshot = createVolatileSnapshot({ cwd, getGitStatus: () => undefined })
    assert.match(snapshot.projectMemoryBlock ?? '', /STATE_MEMORY_SENTINEL/)
    assert.match(snapshot.knowledgeManifestBlock ?? '', /STATE_MANIFEST_SENTINEL/)
  })

  it('still honors caller-supplied blocks on an untrusted project (explicit pass-through)', () => {
    const cwd = tmpProjectWithState()
    isolateHome()
    process.env.RIVET_TRUST_PROJECT = '0'
    const snapshot = createVolatileSnapshot({
      cwd,
      getGitStatus: () => undefined,
      projectMemoryBlock: '<project-memory>caller supplied</project-memory>',
    })
    assert.match(snapshot.projectMemoryBlock!, /caller supplied/)
  })
})
