import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { spawnGitSync } from '../tools/spawn-git.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'

export interface CommitVersion { head: string; index: string; files: string }

/** Hash only selected file bytes; never inspect credentials or escape the checkout. */
export function captureCommitVersion(cwd: string, files: string[]): CommitVersion | null {
  const hash = createHash('sha256')
  const root = resolve(cwd)
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file), rel = relative(root, path)
    if (isAbsolute(rel) || rel.startsWith('..') || detectSensitiveFile(file).sensitive) return null
    hash.update(file)
    try {
      const actual = realpathSync(path), inside = relative(realpathSync(root), actual)
      if (isAbsolute(inside) || inside.startsWith('..')) return null
      hash.update(readFileSync(actual))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      hash.update('deleted')
    }
  }
  const head = spawnGitSync(['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' })
  const index = spawnGitSync(['ls-files', '--stage', '-z'], { cwd, encoding: 'utf8' })
  if (index.status !== 0) return null
  return { head: head.status === 0 ? head.stdout.trim() : 'unborn', index: createHash('sha256').update(index.stdout).digest('hex'), files: hash.digest('hex') }
}
