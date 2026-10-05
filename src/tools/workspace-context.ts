import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPathUnder } from './path-grants.js'

export interface WorkspaceContext {
  sessionId?: string
  roots: readonly string[]
}
const storage = new AsyncLocalStorage<WorkspaceContext>()
export function canonicalRoot(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
export function withWorkspaceRoots<T>(
  roots: readonly string[],
  callback: () => T,
  sessionId?: string,
): T {
  return storage.run({ roots: [...roots], sessionId }, callback)
}
export function currentWorkspaceRoots(cwd: string): readonly string[] {
  const context = storage.getStore()
  const realCwd = canonicalRoot(cwd)
  return context?.roots.some((root) =>
    isPathUnder(canonicalRoot(root), realCwd),
  )
    ? context.roots
    : [cwd]
}
export function isWorkspacePath(cwd: string, realPath: string): boolean {
  return currentWorkspaceRoots(cwd).some((root) =>
    isPathUnder(canonicalRoot(root), realPath),
  )
}
