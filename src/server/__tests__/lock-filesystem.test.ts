import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createLockFileExclusive, readLockFile, removeLockFile, CronLock } from '../cron-lock.js'
import { StoreLock } from '../store-lock.js'

const info = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }

function noLinks<T>(code: string, run: () => T): T {
  const original = fs.linkSync
  fs.linkSync = () => { throw Object.assign(new Error('hard links unavailable'), { code }) }
  syncBuiltinESMExports()
  const restore = () => { fs.linkSync = original; syncBuiltinESMExports() }
  try {
    const result = run()
    if (result instanceof Promise) return result.finally(restore) as T
    restore()
    return result
  } catch (error) { restore(); throw error }
}

for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']) {
  test(`complete directory publication and exclusive competition on ${code}`, () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
    const path = join(root, 'sidecar.lock')
    try {
      noLinks(code, () => {
        assert.deepEqual(createLockFileExclusive(path, info), { ok: true })
        assert.ok(fs.statSync(path).isDirectory())
        assert.deepEqual(readLockFile(path), info)
        assert.deepEqual(createLockFileExclusive(path, { ...info, pid: 123 }), { ok: false, reason: 'exists' })
        assert.deepEqual(readLockFile(path), info)
        assert.deepEqual(fs.readdirSync(root), ['sidecar.lock'], 'no staging debris')
        removeLockFile(path)
        assert.deepEqual(createLockFileExclusive(path, info), { ok: true })
      })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test('fallback cannot overwrite a legacy file lock; unrelated permissions stay errors', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'sidecar.lock')
  try {
    fs.writeFileSync(path, JSON.stringify(info))
    noLinks('EPERM', () => assert.deepEqual(createLockFileExclusive(path, info), { ok: false, reason: 'exists' }))
    assert.deepEqual(readLockFile(path), info)
    removeLockFile(path)
    noLinks('EACCES', () => assert.equal(createLockFileExclusive(path, info).ok, false))
    assert.deepEqual(fs.readdirSync(root), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('interrupted directory preparation never publishes a partial owner', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'sidecar.lock')
  const original = fs.writeFileSync
  fs.writeFileSync = (path, data, options) => {
    if (String(path).endsWith('owner.json')) throw Object.assign(new Error('interrupted write'), { code: 'EIO' })
    return original(path, data, options)
  }
  syncBuiltinESMExports()
  try {
    noLinks('EPERM', () => assert.equal(createLockFileExclusive(path, info).ok, false))
    assert.deepEqual(fs.readdirSync(root), [], 'no canonical lock or staging debris')
  } finally {
    fs.writeFileSync = original
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('directory recovery preserves unknown contents instead of recursively deleting them', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'cron.lock')
  const lock = new CronLock({ lockPath: path })
  try {
    fs.mkdirSync(path)
    fs.writeFileSync(join(path, 'unrelated'), 'keep')
    noLinks('EPERM', () => assert.equal(lock.acquire().status, 'contended'))
    assert.equal(fs.readFileSync(join(path, 'unrelated'), 'utf8'), 'keep')
  } finally { lock.release(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('removing a directory symlink never traverses into the target', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  try {
    const target = join(root, 'target')
    fs.mkdirSync(target)
    fs.writeFileSync(join(target, 'owner.json'), 'keep')
    const path = join(root, 'sidecar.lock')
    fs.symlinkSync(target, path, 'dir')
    removeLockFile(path)
    assert.equal(fs.readFileSync(join(target, 'owner.json'), 'utf8'), 'keep')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('CronLock and StoreLock recover and release directory locks', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const cron = new CronLock({ lockPath: join(root, 'cron.lock') })
  const store = new StoreLock({ lockPath: join(root, 'sidecar.lock'), legacyWriterLockPaths: [] })
  try {
    await noLinks('EPERM', async () => {
      for (const name of ['cron.lock', 'sidecar.lock']) {
        assert.equal(createLockFileExclusive(join(root, name), { ...info, pid: 999999999 }).ok, true)
      }
      assert.equal(cron.acquire().status, 'stale_recovered')
      assert.equal((await store.acquire({ retryWindowMs: 0 })).status, 'stale_recovered')
      cron.release()
      store.release()
      assert.deepEqual(fs.readdirSync(root), [])
    })
  } finally { cron.release(); store.release(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('eight processes publish directory locks with exactly one winner', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'sidecar.lock')
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    fs.linkSync = () => { throw Object.assign(new Error('unsupported'), {code:'EPERM'}) }; syncBuiltinESMExports();
    const { createLockFileExclusive } = await import(${JSON.stringify(new URL('../cron-lock.ts', import.meta.url).href)});
    console.log(JSON.stringify(createLockFileExclusive(process.argv[1], { pid:process.pid, hostname:'test', acquiredAt:'' })));
  `
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path])
      let out = ''; let err = ''
      child.stdout.on('data', d => out += d)
      child.stderr.on('data', d => err += d)
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err)))
    })))
    assert.equal(results.map(r => JSON.parse(r)).filter(r => r.ok).length, 1, results.join(''))
    assert.ok(readLockFile(path))
    assert.deepEqual(fs.readdirSync(root), ['sidecar.lock'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
