import { createHash } from 'node:crypto'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { execFileGit } from '../tools/spawn-git.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'

export class GitWorkbenchError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message) }
}
export function gitRead(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = execFileGit(['--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
      cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        const message = String(stderr || error.message).trim().replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@')
        reject(new GitWorkbenchError(code === 'ENOENT' ? 'git_missing' : /permission denied|EACCES|EPERM/i.test(message) ? 'git_permission' : 'git_failed', message, 422))
      } else resolveResult(String(stdout))
    })
    child.stdin?.end(input)
  })
}
async function optionalGit(cwd: string, args: string[]): Promise<string> {
  try { return (await gitRead(cwd, args)).trim() } catch (e) { if (e instanceof GitWorkbenchError && ['git_missing', 'git_permission'].includes(e.code)) throw e; return '' }
}
export interface RepositoryContext {
  id: string; cwd: string; commonDir: string; branch: string; head: string | null
  upstream: string | null; ahead: number; behind: number; version: string
  remotes: Array<{ name: string; url: string }>
  state: 'ready' | 'unborn' | 'non_repository'
}
export interface GitChange { path: string; originalPath?: string; index: string; worktree: string; conflict: boolean }
export function parseStatus(raw: string): GitChange[] {
  const records = raw.split('\0'), changes: GitChange[] = []
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]!
    if (!entry) continue
    const index = entry[0]!, worktree = entry[1]!, path = entry.slice(3)
    const originalPath = /[RC]/.test(index + worktree) ? records[++i] : undefined
    changes.push({ path, originalPath, index, worktree, conflict: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree) })
  }
  return changes
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export async function repositorySnapshot(inputCwd: string): Promise<{ repository: RepositoryContext; changes: GitChange[] }> {
  const input = await realpath(inputCwd)
  let cwd: string
  try { cwd = (await gitRead(input, ['rev-parse', '--show-toplevel'])).trim() }
  catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) {
      return { repository: { id: hash(input), cwd: input, commonDir: '', branch: '', head: null, upstream: null, ahead: 0, behind: 0, version: '', remotes: [], state: 'non_repository' }, changes: [] }
    }
    throw error
  }
  const commonDir = await realpath(resolve(cwd, (await gitRead(cwd, ['rev-parse', '--git-common-dir'])).trim()))
  const head = await optionalGit(cwd, ['rev-parse', '--verify', 'HEAD'])
  const branch = await optionalGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const raw = await gitRead(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const changes = parseStatus(raw)
  const indexPath = (await gitRead(cwd, ['rev-parse', '--git-path', 'index'])).trim()
  let index = Buffer.alloc(0)
  try { index = await readFile(resolve(cwd, indexPath)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const digest = createHash('sha256').update(head).update(branch).update(index).update(raw)
  for (const change of changes) {
    const path = resolve(cwd, change.path)
    try {
      const info = await lstat(path)
      digest.update(`${change.path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  const upstream = await optionalGit(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const counts = upstream ? (await gitRead(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/).map(Number) : [0, 0]
  const remotes = []
  for (const name of (await gitRead(cwd, ['remote'])).trim().split('\n').filter(Boolean)) {
    const rawUrl = (await gitRead(cwd, ['remote', 'get-url', name])).trim()
    digest.update(name).update(rawUrl)
    const url = rawUrl.replace(/(https?:\/\/)[^/@]+@/, '$1***@')
    remotes.push({ name, url })
  }
  return { repository: { id: hash(cwd), cwd, commonDir, branch: branch || '(detached)', head: head || null, upstream: upstream || null, ahead: counts[0] ?? 0, behind: counts[1] ?? 0, version: digest.digest('hex'), remotes, state: head ? 'ready' : 'unborn' }, changes }
}

const locks = new Map<string, Promise<unknown>>()
export async function withRepositoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  locks.set(key, current)
  try { return await current } finally { if (locks.get(key) === current) locks.delete(key) }
}
export async function checkedRepositoryWrite<T>(cwd: string, version: unknown, operation: (snapshot: Awaited<ReturnType<typeof repositorySnapshot>>) => Promise<T>): Promise<T> {
  const initial = await repositorySnapshot(cwd)
  if (!initial.repository.commonDir) throw new GitWorkbenchError('non_repository', '请选择 Git 仓库')
  return withRepositoryLock(initial.repository.commonDir, async () => {
    const snapshot = await repositorySnapshot(cwd)
    if (typeof version !== 'string' || !version || snapshot.repository.version !== version) throw new GitWorkbenchError('stale_snapshot', '仓库已变化，请刷新并重新查看操作范围')
    return operation(snapshot)
  })
}
export function checkGitPath(cwd: string, path: unknown): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) throw new GitWorkbenchError('invalid_path', '无效文件路径', 400)
  const rel = relative(cwd, resolve(cwd, path))
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new GitWorkbenchError('invalid_path', '文件不在仓库内', 400)
  if (rel.replace(/\\/g, '/').split('/')[0]?.toLowerCase() === '.git') throw new GitWorkbenchError('invalid_path', '不能读取 Git 内部文件', 403)
  if (detectSensitiveFile(rel).sensitive) throw new GitWorkbenchError('sensitive_file', '敏感文件不能通过 Git 工作台读取或提交', 403)
  return rel
}
export async function workbenchDiff(cwd: string, path: string, staged: boolean): Promise<string> {
  checkGitPath(cwd, path)
  if (!staged && (await gitRead(cwd, ['ls-files', '--', path])).trim() === '') {
    // --no-index exits 1 for differences; render untracked text without treating
    // it as a process failure. Binary and large files remain file-level only.
    const info = await lstat(resolve(cwd, path))
    if (!info.isFile()) throw new GitWorkbenchError('file_type', '只支持读取仓库内普通文件', 422)
    const diskPath = await realpath(resolve(cwd, path))
    const diskRelative = relative(await realpath(cwd), diskPath)
    checkGitPath(cwd, diskRelative)
    if (info.size > 1024 * 1024) throw new GitWorkbenchError('large_file', '文件超过 1MB，请在编辑器查看', 422)
    const data = await readFile(resolve(cwd, path))
    if (data.includes(0)) return `Binary file ${path}`
    const lines = data.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
  }
  return gitRead(cwd, ['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--', path])
}
export async function commitStaged(cwd: string, message: string): Promise<{ ok: true; sha: string }> {
  if (!message.trim()) throw new GitWorkbenchError('empty_message', '请输入提交说明', 400)
  const files = (await gitRead(cwd, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  if (!files.length) throw new GitWorkbenchError('empty_index', '没有已暂存内容，请先选择文件或片段')
  for (const file of files) checkGitPath(cwd, file)
  await gitRead(cwd, ['commit', '-m', message])
  return { ok: true, sha: (await gitRead(cwd, ['rev-parse', 'HEAD'])).trim() }
}
export async function history(cwd: string, offset = 0, limit = 50) {
  const snapshot = await repositorySnapshot(cwd)
  if (!snapshot.repository.head) return { commits: [], hasMore: false }
  const raw = await gitRead(cwd, ['log', '--all', '--topo-order', `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x00'])
  const fields = raw.split('\0'), commits = []
  for (let i = 0; i + 5 < fields.length; i += 6) commits.push({ sha: fields[i]!.trim(), parents: fields[i + 1]!.split(' ').filter(Boolean), author: fields[i + 2]!, time: Number(fields[i + 3]), refs: fields[i + 4]!, subject: fields[i + 5]! })
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
}
