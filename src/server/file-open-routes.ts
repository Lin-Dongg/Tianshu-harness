import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { realpath, stat, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { isAuthorizedRequest } from './auth.js'
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'

const mime: Record<string, string> = { '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.hdr': 'application/octet-stream', '.ktx2': 'image/ktx2', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) }

export interface FilePreviewResource { url: string; server: Server; state(): Promise<{ version: string; servedVersion: string; errors: string[] }> }

/** Separate origin: delivered HTML never shares the authenticated sidecar origin. */
export async function startFilePreview(root: string, path: string): Promise<FilePreviewResource> {
  root = await realpath(root)
  path = await realpath(path)
  const key = randomBytes(24).toString('hex')
  const served = new Map<string, string>()
  const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
  served.set(path, digest(await readFile(path)))
  const errors = new Set<string>()
  const version = (entries: [string, string][]) => createHash('sha256').update(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET' || !req.url?.startsWith('/' + key + '/')) { if (req.method === 'GET' && req.url) errors.add(req.url.split('?')[0] ?? req.url); res.writeHead(404).end(); return }
      const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(key.length + 2))
      const file = await realpath(resolve(root, requestPath))
      const type = mime[extname(file).toLowerCase()]
      const parts = relative(root, file).split(/[/\\]/)
      const forbidden = parts.some((p, i) => (p.startsWith('.') && !(p === '.rivet' && parts[i + 1] === 'artifacts')) || /(?:credentials|secret|token|private.*key)/i.test(p))
      if (!inside(root, file) || !type || forbidden) { errors.add(requestPath); res.writeHead(403).end(); return }
      const info = await stat(file)
      if (!info.isFile() || info.size > 32 * 1024 * 1024) { errors.add(requestPath); res.writeHead(413).end(); return }
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' })
      const bytes = await readFile(file)
      served.set(file, digest(bytes)); errors.delete(requestPath)
      res.end(bytes)
    })().catch(() => { if (req.url) errors.add(new URL(req.url, 'http://localhost').pathname.split('/').slice(2).join('/')); if (!res.headersSent) res.writeHead(404); res.end() })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  server.unref()
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/${key}/${relative(root, path).split(/[/\\]/).map(encodeURIComponent).join('/')}`
  return { url, server, async state() {
    const current: [string, string][] = []
    for (const file of served.keys()) {
      try { const actual = await realpath(file); if (actual !== file || !inside(root, actual)) throw Error('Target changed'); current.push([file, digest(await readFile(file))]) }
      catch { current.push([file, 'missing']) }
    }
    return { version: version(current), servedVersion: version([...served]), errors: [...errors].slice(0, 8) }
  } }
}

export function chromeCommand(path: string, platform = process.platform) {
  const url = pathToFileURL(path).href
  if (platform === 'darwin') return { cmd: 'open', args: ['-a', 'Google Chrome', url], wait: true }
  if (platform === 'win32') {
    const cmd = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(base => join(base!, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(existsSync)
    if (!cmd) throw new Error('Google Chrome is not installed')
    return { cmd, args: [url], wait: false }
  }
  return { cmd: 'google-chrome', args: [url], wait: false }
}
async function openChrome(path: string) {
  const command = chromeCommand(path)
  await new Promise<void>((done, reject) => {
    const child = spawn(command.cmd, command.args, { detached: !command.wait, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    if (command.wait) child.once('exit', code => code === 0 ? done() : reject(new Error('Google Chrome could not be opened; check installation')))
    else child.once('spawn', () => { child.unref(); done() })
  })
}
const resourceStores = new Set<Map<string, FilePreviewResource & { previewId: string; sessionId: string; timer: ReturnType<typeof setTimeout> }>>()
const disposedSessions = new Map<string, number>()
let disposalGeneration = 0
export function disposeSessionFilePreviews(sessionId?: string) {
  if (sessionId) disposedSessions.set(sessionId, (disposedSessions.get(sessionId) ?? 0) + 1)
  else disposalGeneration++
  for (const store of resourceStores) for (const [id, p] of store) if (!sessionId || p.sessionId === sessionId) { clearTimeout(p.timer); p.server.close(); store.delete(id) }
}
export function buildFileOpenRoutes(manager: RuntimeSessionManager, apiToken?: string, launch = openChrome): Record<string, RouteHandler> {
  const previews = new Map<string, FilePreviewResource & { previewId: string; sessionId: string; timer: ReturnType<typeof setTimeout> }>()
  const tasks = new Map<string, Promise<unknown>>()
  let pendingOpen = 0
  resourceStores.add(previews)
  const renew = (id: string, p: FilePreviewResource & { timer: ReturnType<typeof setTimeout> }) => { clearTimeout(p.timer); p.timer = setTimeout(() => { p.server.close(); previews.delete(id) }, 30 * 60 * 1000); p.timer.unref() }
  return { 'POST /file-open': async (body, _params, headers) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) return { status: 401, body: { error: 'Unauthorized' } }
    const input = body as Record<string, unknown>
    if (!input || typeof input.sessionId !== 'string' || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || typeof input.path !== 'string' || !['preview', 'chrome', 'status', 'release'].includes(String(input.action))) return { status: 400, body: { error: 'Explicit session, root, path and opening action required' } }
    if (input.action === 'release') {
      const entry = [...previews].find(([, p]) => p.sessionId === input.sessionId && p.previewId === input.previewId)
      if (entry) { clearTimeout(entry[1].timer); entry[1].server.close(); previews.delete(entry[0]) }
      return { status: 200, body: { ok: true } }
    }
    const sessionId = input.sessionId
    const generation = disposalGeneration, sessionGeneration = disposedSessions.get(sessionId) ?? 0
    const session = manager.listSessions().find(s => s.id === sessionId)
    if (!session || ![session.cwd, ...(session.workspaceRoots ?? [])].some(root => root && resolve(root) === resolve(input.cwd as string))) return { status: 403, body: { error: 'File root does not belong to this session' } }
    try {
      const root = await realpath(input.cwd), path = await realpath(resolve(root, input.path))
      if (!inside(root, path) || !(await stat(path)).isFile() || !/\.(?:html?|pdf|svg)$/i.test(path)) return { status: 403, body: { error: 'Unsupported browser file or path outside session root' } }
      if (input.action === 'chrome') { await launch(path); return { status: 200, body: { opened: path } } }
      if (!/\.html?$/i.test(path)) return { status: 400, body: { error: 'Browser preview requires HTML' } }
      const id = input.sessionId + '\0' + root + '\0' + path
      const previousTask = tasks.get(id) ?? Promise.resolve()
      const work = previousTask.catch(() => {}).then(async () => {
      const previous = previews.get(id)
      if (input.action === 'status') {
        if (!previous || previous.previewId !== input.previewId) return { status: 410, body: { code: 'stale_context', error: 'File preview expired' } }
        renew(id, previous)
        return { status: 200, body: { ...(await previous.state()), previewId: previous.previewId } }
      }
      if (previous) clearTimeout(previous.timer)
      else if (previews.size + pendingOpen >= 32) return { status: 429, body: { error: 'Close older previews or retry after expiry' } }
      let preview: FilePreviewResource | undefined = previous
      if (!preview) { pendingOpen++; try { preview = await startFilePreview(root, path) } finally { pendingOpen-- } }
      if (generation !== disposalGeneration || sessionGeneration !== (disposedSessions.get(sessionId) ?? 0) || !manager.listSessions().some(s => s.id === sessionId)) { preview.server.close(); return { status: 410, body: { code: 'stale_context', error: 'Session removed during preview creation' } } }
      const timer = setTimeout(() => { preview.server.close(); previews.delete(id) }, 30 * 60 * 1000)
      timer.unref(); const resource = { ...preview, timer, previewId: previous?.previewId ?? randomUUID(), sessionId }; previews.set(id, resource)
      return { status: 200, body: { url: preview.url, previewId: resource.previewId, ...(await preview.state()) } }
      })
      tasks.set(id, work)
      try { return await work } finally { if (tasks.get(id) === work) tasks.delete(id) }
    } catch (e) { return { status: 422, body: { error: String(e) } } }
  } }
}
