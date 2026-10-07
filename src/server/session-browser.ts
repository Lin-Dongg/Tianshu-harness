import { createBrowserContext, contextFor, renewBrowserContext, disposeBrowserContext } from './browser-contexts.js'
import { withWorkspaceRoots } from '../tools/workspace-context.js'
import type { BrowserDebugDriver } from '../tools/browser-debug/driver.js'
import { copyFileSync, constants } from 'node:fs'
import { parse, join } from 'node:path'
import {
  getOrCreateSession,
  getSession,
} from '../tools/browser-debug/session.js'
import { defaultUserDataDir } from '../tools/browser-debug/profiles.js'
import { BrowserOperationError, browserErrorResponse } from '../tools/browser-debug/operation-error.js'
import { BROWSER_CONTEXT_SCRIPT } from '../tools/browser-debug/selection.js'
import {
  browserOperation,
  browserOwner,
  takeBrowserControl,
} from '../tools/browser-debug/control.js'
import { validatePath } from '../tools/path-validate.js'
import { withAuth } from './route-auth.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { RouteHandler } from './index.js'
export function browserUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new BrowserOperationError('invalid_input', 'HTTP or HTTPS address required')
  let url: URL
  try { url = new URL(raw) } catch { throw new BrowserOperationError('invalid_input', 'HTTP or HTTPS address required') }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new BrowserOperationError('invalid_input', 'Only HTTP and HTTPS addresses are supported')
  return url.href
}
export function buildSessionBrowserRoutes(
  manager: RuntimeSessionManager,
  apiToken?: string,
): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {
    'GET /sessions/:id/browser': withAuth(async (_body, params) => {
      const sessionId = params!.id!
      let context
      try { context = params?.contextId !== undefined ? contextFor(sessionId, params.contextId) : undefined } catch (e) { return browserErrorResponse(e) }
      const id = context?.browserKey ?? sessionId
      if (!manager.getSession(sessionId))
        return { status: 404, body: { error: 'Session not found' } }
      if (context) renewBrowserContext(context)
      const session = getSession(id)
      if (!session)
        return {
          status: 200,
          body: {
            owner: browserOwner(id),
            pages: [],
            downloads: [],
            ready: false,
          },
        }
      try {
        const pages = await browserOperation(id, browserOwner(id), async () => (await session.driver.listPages?.()) ?? [])
        return {
          status: 200,
          body: {
            owner: browserOwner(id),
            interactionId: session.frames.interactionId,
            pages,
            downloads: (session.driver.downloads?.() ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              ready: Boolean(d.path),
            })),
            ready: true,
            ...(context ? { errors: session.log.getConsole('error').filter(e => !/^Failed to load resource:/i.test(e.text)).slice(-5).map(e => e.text) } : {}),
          },
        }
      } catch (error) { return browserErrorResponse(error) }
    }, apiToken),
    'POST /sessions/:id/browser': withAuth(async (body, params) => {
      const sessionId = params!.id!, record = manager.getSession(sessionId)
      if (!record) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as {
        action?: string
        contextId?: string
        url?: unknown
        pageId?: string
        text?: string
        files?: string[]
        uploads?: Array<{
          name: string
          dataUrl: string
        }>
        downloadId?: string
        path?: string
        owner?: string
        width?: number
        height?: number
        expectedInteractionId?: unknown
      }
      try {
        const context = data.contextId !== undefined ? contextFor(sessionId, data.contextId) : undefined
        const id = context?.browserKey ?? sessionId
        if (context) renewBrowserContext(context)
        if (data.action === 'control') {
          if ((context && data.owner !== 'user') || (data.owner !== 'user' && data.owner !== 'agent'))
            throw new BrowserOperationError('invalid_input', 'Invalid owner')
          await takeBrowserControl(id, data.owner, {
            beforeChange: async () => { await getSession(id)?.frames.releaseInput() },
            afterChange: async () => { await getSession(id)?.frames.changeInteraction() },
          })
          return { status: 200, body: { ok: true, owner: browserOwner(id), interactionId: getSession(id)?.frames.interactionId } }
        }
        const allowed = [
          'viewport',
          'new',
          'open',
          'navigate',
          'back',
          'forward',
          'reload',
          'select',
          'close',
          'text',
          'context',
          'upload',
          'download',
          'release',
          'screenshot',
        ]
        if (!allowed.includes(data.action ?? ''))
          throw new BrowserOperationError('invalid_input', 'Invalid browser action')
        const url =
          data.action === 'open' || data.action === 'navigate'
            ? browserUrl(data.url)
            : undefined
        const result = await browserOperation(id, 'user', async () => {
          if (context) contextFor(sessionId, context.id)
          const existing = getSession(id)
          if (context && existing && data.expectedInteractionId === undefined) throw new BrowserOperationError('stale_context', 'Context operations require an interaction identity')
          if (data.expectedInteractionId !== undefined) {
            if (!existing) throw new BrowserOperationError('stale_context', 'Browser instance changed')
            existing.frames.assertInteraction(data.expectedInteractionId)
          }
          const session = await getOrCreateSession({
            sessionKey: id,
            headless: true,
            userDataDir: context?.profile ?? defaultUserDataDir(id),
          })
          if (context) contextFor(sessionId, context.id)
          const driver = session.driver
          if (context && ['new', 'open'].includes(data.action!) && ((await driver.listPages?.()) ?? []).filter(p => p.url !== 'about:blank').length >= 8 && !((await driver.listPages?.()) ?? []).some(p => p.url === url)) throw new BrowserOperationError('resource_limit', 'Close an older file preview')
          if (data.action === 'viewport') {
            if (!Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width! < 240 || data.width! > 4096 || data.height! < 120 || data.height! > 4096)
              throw new BrowserOperationError('invalid_input', 'Invalid viewport size')
            const size = driver.viewportSize()
            if (size && size.width === data.width && size.height === data.height)
              return { ok: true, interactionId: session.frames.interactionId }
          }
          function capability<
            K extends
              | 'newPage'
              | 'selectPage'
              | 'closePage'
              | 'insertText'
              | 'uploadFiles'
              | 'uploadBuffers',
          >(name: K): NonNullable<BrowserDebugDriver[K]> {
            const fn = driver[name]
            if (!fn) throw new BrowserOperationError('capability_unsupported', 'Browser capability unavailable: ' + name)
            return fn as NonNullable<BrowserDebugDriver[K]>
          }
          const switchesPage = [
            'viewport',
            'new',
            'open',
            'select',
            'close',
            'navigate',
            'back',
            'forward',
            'reload',
          ].includes(data.action!)
          if (switchesPage) { await session.frames.releaseInput(); await session.frames.detach() }
          try {
            switch (data.action) {
              case 'viewport': {
                if (
                  !Number.isInteger(data.width) ||
                  !Number.isInteger(data.height) ||
                  data.width! < 240 ||
                  data.width! > 4096 ||
                  data.height! < 120 ||
                  data.height! > 4096
                )
                  throw new BrowserOperationError('invalid_input', 'Invalid viewport size')
                if (context) session.frames.setOptions({ quality: 90, maxWidth: data.width!, maxHeight: data.height! })
                await driver.setViewport(data.width!, data.height!)
                break
              }
              case 'new':
                await capability('newPage').call(driver, 'about:blank')
                break
              case 'open': {
                const pages = (await driver.listPages?.()) ?? []
                const found = pages.find((p) => p.url === url)
                if (found) await capability('selectPage').call(driver, found.id)
                else await capability('newPage').call(driver, url!)
                break
              }
              case 'navigate':
                await driver.goto(url!)
                break
              case 'back':
                await driver.goBack()
                break
              case 'forward':
                await driver.goForward()
                break
              case 'reload':
                await driver.reload()
                break
              case 'select':
                await capability('selectPage').call(driver, data.pageId ?? '')
                break
              case 'close':
                await capability('closePage').call(driver, data.pageId ?? '')
                break
              case 'text':
                if (typeof data.text !== 'string' || data.text.length > 100000)
                  throw new BrowserOperationError('invalid_input', 'Invalid text')
                await capability('insertText').call(driver, data.text, () => session.frames.assertInteraction(data.expectedInteractionId))
                break
              case 'upload': {
                if (data.uploads) {
                  if (
                    !Array.isArray(data.uploads) ||
                    !data.uploads.length ||
                    data.uploads.length > 20
                  )
                    throw new BrowserOperationError('invalid_input', 'Choose up to 20 files')
                  let size = 0
                  const files = data.uploads.map((item) => {
                    if (
                      typeof item.name !== 'string' ||
                      !item.name ||
                      item.name.length > 255 ||
                      /[\\/]/.test(item.name) ||
                      item.name === '.' ||
                      item.name === '..'
                    )
                      throw new BrowserOperationError('invalid_input', 'Invalid upload filename')
                    const match =
                      typeof item.dataUrl === 'string'
                        ? item.dataUrl.match(
                            /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/,
                          )
                        : null
                    if (!match) throw new BrowserOperationError('invalid_input', 'Invalid upload data')
                    const buffer = Buffer.from(match[2]!, 'base64')
                    size += buffer.length
                    if (size > 32 * 1024 * 1024)
                      throw new BrowserOperationError('invalid_input',
                        'Uploads exceed 32MB; choose smaller files',
                      )
                    return {
                      name: item.name,
                      mimeType: match[1] || 'application/octet-stream',
                      buffer,
                    }
                  })
                  await capability('uploadBuffers').call(driver, files)
                } else {
                  if (
                    !Array.isArray(data.files) ||
                    !data.files.length ||
                    data.files.length > 20
                  )
                    throw new BrowserOperationError('invalid_input', 'Choose files to upload')
                  await capability('uploadFiles').call(
                    driver,
                    data.files.map((path) =>
                      validatePath(record.cwd, path, 'read'),
                    ),
                  )
                }
                break
              }
              case 'download': {
                const download = driver
                  .downloads?.()
                  .find((d) => d.id === data.downloadId)
                if (!download?.path) throw new BrowserOperationError('invalid_input', 'Download is not ready')
                const requested = data.path ?? download.name
                const name = parse(requested)
                for (let attempt = 0; attempt < 100; attempt++) {
                  const destination =
                    attempt === 0
                      ? requested
                      : join(name.dir, `${name.name} (${attempt})${name.ext}`)
                  const path = validatePath(record.cwd, destination, 'write')
                  try {
                    copyFileSync(download.path, path, constants.COPYFILE_EXCL)
                    return { path }
                  } catch (error) {
                    if (
                      data.path ||
                      (error as NodeJS.ErrnoException).code !== 'EEXIST'
                    )
                      throw error
                  }
                }
                throw new BrowserOperationError('invalid_input', 'Choose another download filename')
              }
              case 'context': {
                const context = await driver.evaluate(BROWSER_CONTEXT_SCRIPT)
                session.frames.assertInteraction(data.expectedInteractionId)
                return JSON.parse(context) as {
                  title: string
                  url: string
                  selection: string
                }
              }
              case 'screenshot': {
                session.frames.assertInteraction(data.expectedInteractionId)
                const image = await driver.screenshot({ raw: true })
                session.frames.assertInteraction(data.expectedInteractionId)
                return { data: image.toString('base64'), mime: 'image/png' }
              }
              case 'release':
                await session.frames.releaseInput()
                break
            }
            return { ok: true, interactionId: session.frames.interactionId }
          } finally {
            if (switchesPage) await session.frames.rebind(driver)
          }
        })
        return { status: 200, body: { ...result, interactionId: getSession(id)?.frames.interactionId } }
      } catch (err) { return browserErrorResponse(err) }
    }, apiToken),
  }
  routes['POST /sessions/:id/browser/contexts'] = withAuth(async (_body, params) => {
    const sessionId = params!.id!
    if (!manager.getSession(sessionId)) return { status: 404, body: { error: 'Session not found' } }
    try {
      const c = await createBrowserContext(sessionId)
      if (!manager.getSession(sessionId)) { await disposeBrowserContext(sessionId, c.id); throw new BrowserOperationError('stale_context', 'Session was removed') }
      const session = getSession(c.browserKey)
      const pages = session ? await browserOperation(c.browserKey, 'user', async () => (await session.driver.listPages?.()) ?? []) : []
      return { status: 200, body: { contextId: c.id, browserKey: c.browserKey, owner: 'user', ready: !!session, pages, interactionId: session?.frames.interactionId } }
    } catch (e) { return browserErrorResponse(e) }
  }, apiToken)
  routes['DELETE /sessions/:id/browser/contexts/:contextId'] = withAuth(async (_body, params) => {
    await disposeBrowserContext(params!.id!, params!.contextId!)
    return { status: 200, body: { ok: true } }
  }, apiToken)
  for (const [key,handler] of Object.entries(routes)) routes[key]=(body,params,headers,res)=>{
    const rec=params?.id?manager.getSession(params.id):undefined
    return rec?withWorkspaceRoots(rec.workspaceRoots??[rec.cwd],()=>handler(body,params,headers,res),rec.id):handler(body,params,headers,res)
  }
  return routes
}
