import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { realpath, stat, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { isAuthorizedRequest } from './auth.js'
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'

const mime: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) }

/** Separate origin: delivered HTML never shares the authenticated sidecar origin. */
export async function startFilePreview(root: string, path: string): Promise<{ url: string; server: Server }> {
  root = await realpath(root)
  path = await realpath(path)
  const key = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET' || !req.url?.startsWith('/' + key + '/')) { res.writeHead(404).end(); return }
      const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(key.length + 2))
      const file = await realpath(resolve(root, requestPath))
      const type = mime[extname(file).toLowerCase()]
      const parts = relative(root, file).split(/[/\\]/)
      const forbidden = parts.some((p, i) => (p.startsWith('.') && !(p === '.rivet' && parts[i + 1] === 'artifacts')) || /(?:credentials|secret|token|private.*key)/i.test(p))
      if (!inside(root, file) || !type || forbidden) { res.writeHead(403).end(); return }
      const info = await stat(file)
      if (!info.isFile() || info.size > 32 * 1024 * 1024) { res.writeHead(413).end(); return }
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' })
      res.end(await readFile(file))
    })().catch(() => { if (!res.headersSent) res.writeHead(404); res.end() })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  server.unref()
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/${key}/${relative(root, path).split(/[/\\]/).map(encodeURIComponent).join('/')}`
  return { url, server }
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
export function buildFileOpenRoutes(manager: RuntimeSessionManager, apiToken?: string, launch = openChrome): Record<string, RouteHandler> {
  const previews = new Map<string, { url: string; server: Server; timer: ReturnType<typeof setTimeout> }>()
  return { 'POST /file-open': async (body, _params, headers) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) return { status: 401, body: { error: 'Unauthorized' } }
    const input = body as Record<string, unknown>
    if (!input || typeof input.sessionId !== 'string' || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || typeof input.path !== 'string' || !['preview', 'chrome'].includes(String(input.action))) return { status: 400, body: { error: 'Explicit session, root, path and opening action required' } }
    const session = manager.listSessions().find(s => s.id === input.sessionId)
    if (!session || ![session.cwd, ...(session.workspaceRoots ?? [])].some(root => root && resolve(root) === resolve(input.cwd as string))) return { status: 403, body: { error: 'File root does not belong to this session' } }
    try {
      const root = await realpath(input.cwd), path = await realpath(resolve(root, input.path))
      if (!inside(root, path) || !(await stat(path)).isFile() || !/\.(?:html?|pdf|svg)$/i.test(path)) return { status: 403, body: { error: 'Unsupported browser file or path outside session root' } }
      if (input.action === 'chrome') { await launch(path); return { status: 200, body: { opened: path } } }
      if (!/\.html?$/i.test(path)) return { status: 400, body: { error: 'Browser preview requires HTML' } }
      const id = root + '\0' + path
      const previous = previews.get(id)
      if (previous) clearTimeout(previous.timer)
      else if (previews.size >= 16) return { status: 429, body: { error: 'Close older previews or retry after expiry' } }
      const preview = previous ?? await startFilePreview(root, path)
      const timer = setTimeout(() => { preview.server.close(); previews.delete(id) }, 30 * 60 * 1000)
      timer.unref(); previews.set(id, { ...preview, timer })
      return { status: 200, body: { url: preview.url } }
    } catch (e) { return { status: 422, body: { error: String(e) } } }
  } }
}
