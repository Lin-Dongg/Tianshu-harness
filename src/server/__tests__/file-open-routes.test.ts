import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFileOpenRoutes, startFilePreview, chromeCommand } from '../file-open-routes.js'
import { createRouter } from '../index.js'
import type { RuntimeSessionManager } from '../session-manager.js'

test('real opening route requires authentication and explicit registered conversation root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-open-'))
  const launches: string[] = []
  const manager = { listSessions: () => [{ id: 's', cwd: root }] } as unknown as RuntimeSessionManager
  const call = createRouter(buildFileOpenRoutes(manager, 'test', async p => { launches.push(p) }))
  const body = { sessionId: 's', cwd: root, path: '中文 & page.html', action: 'chrome' }
  try {
    await writeFile(join(root, body.path), '<h1>test</h1>')
    assert.equal((await call('POST', '/file-open', body, {})).status, 401)
    assert.equal((await call('POST', '/file-open', { ...body, cwd: tmpdir() }, { authorization: 'Bearer test' })).status, 403)
    assert.equal((await call('POST', '/file-open', { ...body, cwd: undefined }, { authorization: 'Bearer test' })).status, 400)
    assert.equal((await call('POST', '/file-open', body, { authorization: 'Bearer test' })).status, 200)
    assert.deepEqual(launches, [await realpath(join(root, body.path))])
    const failure = createRouter(buildFileOpenRoutes(manager, 'test', async () => { throw Error('Chrome missing') }))
    assert.equal((await failure('POST', '/file-open', body, { authorization: 'Bearer test' })).status, 422)
    assert.deepEqual(chromeCommand(join(root, body.path), 'darwin').args.slice(0, 2), ['-a', 'Google Chrome'])
    assert.equal(fileURLToPath(chromeCommand(join(root, body.path), 'darwin').args[2]!), join(root, body.path))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('HTML preview has separate capability origin, relative assets and fail-closed file boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-preview-'))
  const outside = await mkdtemp(join(tmpdir(), 'file-preview-outside-'))
  await mkdir(join(root, '页面'))
  await writeFile(join(root, '页面', 'demo.html'), '<link href="../style.css"><h1>demo</h1>')
  await writeFile(join(root, 'style.css'), 'h1{color:red}')
  await mkdir(join(root, '.rivet', 'artifacts'), { recursive: true })
  await writeFile(join(root, '.rivet', 'artifacts', 'demo.html'), 'artifact preview')
  await writeFile(join(root, 'secret.json'), '{"test":true}')
  await writeFile(join(outside, 'outside.js'), 'outside')
  await symlink(join(outside, 'outside.js'), join(root, 'escape.js'))
  const preview = await startFilePreview(root, join(root, '页面', 'demo.html'))
  try {
    assert.match(await (await fetch(preview.url)).text(), /demo/)
    assert.equal(await (await fetch(new URL('../style.css', preview.url))).text(), 'h1{color:red}')
    assert.equal(await (await fetch(new URL('../.rivet/artifacts/demo.html', preview.url))).text(), 'artifact preview')
    assert.equal((await fetch(new URL('../escape.js', preview.url))).status, 403)
    assert.equal((await fetch(new URL('../secret.json', preview.url))).status, 403)
    assert.equal((await fetch(new URL('/style.css', preview.url))).status, 404)
    assert.equal((await fetch(preview.url, { method: 'POST' })).status, 404)
  } finally { await new Promise<void>(done => preview.server.close(() => done())); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
