import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const git = promisify(execFile)
const nonRepositories = new Set<string>()
export class NonRepositoryError extends Error {
  constructor() { super('Current directory is not a Git repository'); this.name = 'NonRepositoryError' }
}
function hasGitMarker(cwd: string): boolean {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git')) || (existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** Only Git's explicit non-repository response is cached; transient errors remain unknown. */
export async function repositoryCapability(cwd: string): Promise<'repository' | 'non_repository' | 'unknown'> {
  const root = resolve(cwd)
  if (nonRepositories.has(root) && !hasGitMarker(root)) return 'non_repository'
  try {
    await git('git', ['rev-parse', '--git-dir'], { cwd: root, timeout: 1500, encoding: 'utf8', windowsHide: true })
    nonRepositories.delete(root)
    return 'repository'
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr))) { nonRepositories.add(root); return 'non_repository' }
    return 'unknown'
  }
}

export function resetRepositoryCapabilityForTests(): void { nonRepositories.clear() }
