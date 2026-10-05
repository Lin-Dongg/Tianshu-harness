import { createHash } from 'node:crypto'
import {
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
  chmodSync,
} from 'node:fs'
import { dirname, basename, join, relative } from 'node:path'
import { validatePath } from '../tools/path-validate.js'
import { decodeContextText } from './file-context-policy.js'
import { withAuth } from './route-auth.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { RouteHandler } from './index.js'
export const documentVersion = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')
export class DocumentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
const LIMIT = 512 * 1024
function assertDocumentPath(abs: string) {
  if (/(?:^|[\\/])\.rivet[\\/]plans[\\/][^\\/]+\.md$/i.test(abs))
    throw new DocumentError(409, 'Open plans through the plan service')
}
export function readDocument(cwd: string, path: string) {
  const abs = validatePath(cwd, path, 'read')
  assertDocumentPath(abs)
  assertDocumentPath(realpathSync(abs))
  const stat = statSync(abs)
  if (!stat.isFile()) throw new DocumentError(400, 'Not a file')
  if (stat.size > LIMIT)
    throw new DocumentError(
      413,
      'File exceeds 512KB; open in an external editor',
    )
  const bytes = readFileSync(abs)
  let editable = true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (bytes.includes(0)) editable = false
  } catch {
    editable = false
  }
  return {
    path: relative(cwd, abs),
    content: decodeContextText(bytes),
    version: documentVersion(bytes),
    editable,
    encoding: editable ? 'utf-8' : 'other',
  }
}
export function saveDocument(
  cwd: string,
  path: string,
  content: string,
  version: string,
  create = false,
) {
  if (Buffer.byteLength(content) > LIMIT)
    throw new DocumentError(413, 'File exceeds 512KB')
  let abs = validatePath(cwd, path, 'write')
  assertDocumentPath(abs)
  if (create) {
    // Exclusive creation cannot overwrite an existing destination, including a symlink.
    writeFileSync(abs, content, { flag: 'wx', mode: 0o600 })
  } else {
    const before = readDocument(cwd, path)
    if (!before.editable)
      throw new DocumentError(415, 'Only UTF-8 text can be edited')
    if (before.version !== version)
      throw new DocumentError(
        409,
        'File changed on disk; review the differences before saving',
      )
    abs = realpathSync(abs)
    validatePath(cwd, abs, 'write')
    const bytes = readFileSync(abs)
    const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
      ? '\uFEFF'
      : ''
    const temp = join(
      dirname(abs),
      `.${basename(abs)}.edit-${process.pid}-${Math.random().toString(36).slice(2)}`,
    )
    try {
      writeFileSync(temp, bom + content, {
        flag: 'wx',
        mode: statSync(abs).mode,
      })
      chmodSync(temp, statSync(abs).mode & 0o777)
      if (documentVersion(readFileSync(abs)) !== version)
        throw new DocumentError(
          409,
          'File changed on disk; review the differences before saving',
        )
      renameSync(temp, abs)
    } finally {
      try {
        unlinkSync(temp)
      } catch {}
    }
  }
  return readDocument(cwd, path)
}
export function buildDocumentRoutes(
  manager: RuntimeSessionManager,
  apiToken?: string,
): Record<string, RouteHandler> {
  const handle = (write: boolean): RouteHandler =>
    withAuth(async (body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as {
        path?: unknown
        content?: unknown
        version?: unknown
        create?: unknown
      }
      const path = write ? data.path : params?.path
      if (typeof path !== 'string' || !path)
        return { status: 400, body: { error: 'File path required' } }
      if (
        write &&
        (typeof data.content !== 'string' || typeof data.version !== 'string')
      )
        return { status: 400, body: { error: 'Content and version required' } }
      try {
        return {
          status: 200,
          body: write
            ? saveDocument(
                rec.cwd,
                path,
                data.content as string,
                data.version as string,
                data.create === true,
              )
            : readDocument(rec.cwd, path),
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        return {
          status:
            err instanceof DocumentError
              ? err.status
              : e.code === 'ENOENT'
                ? 404
                : e.code === 'EEXIST'
                  ? 409
                  : 403,
          body: { error: e.message },
        }
      }
    }, apiToken)
  return {
    'GET /sessions/:id/file-document': handle(false),
    'PUT /sessions/:id/file-document': handle(true),
  }
}
