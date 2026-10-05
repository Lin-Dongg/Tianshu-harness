import { isAbsolute } from 'node:path'
import { isKnownWorkspace, registeredWorkspaces } from './workspace-guard.js'
import { withAuth } from './route-auth.js'
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'
import { checkGitPath, checkedRepositoryWrite, commitStaged, gitRead, GitWorkbenchError, history, repositorySnapshot, workbenchDiff } from './git-workbench.js'

export function resolveGitCwd(manager: RuntimeSessionManager, input: { cwd?: unknown; sessionId?: unknown }): string {
  const session = typeof input.sessionId === 'string' ? manager.getSession(input.sessionId) : undefined
  if (input.sessionId && !session) throw new GitWorkbenchError('session_missing', '会话不存在', 404)
  const cwd = typeof input.cwd === 'string' ? input.cwd : session?.worktreePath ?? session?.cwd
  if (!cwd || !isAbsolute(cwd)) throw new GitWorkbenchError('context_missing', '请选择仓库目录', 400)
  const known = [manager.getDefaultCwd(), ...registeredWorkspaces(manager), ...manager.listSessions().flatMap(s => [s.cwd, ...(s.workspaceRoots ?? []), ...(s.worktreePath ? [s.worktreePath] : [])])]
  if (!isKnownWorkspace(cwd, known)) throw new GitWorkbenchError('unknown_workspace', '目录不在已登记工作区中', 403)
  return cwd
}
export function buildGitWorkbenchRoutes(manager: RuntimeSessionManager, apiToken?: string): Record<string, RouteHandler> {
  const route = (fn: (cwd: string, data: Record<string, unknown>) => Promise<unknown>, write = false): RouteHandler => withAuth(async (body, params) => {
    const data = { ...params, ...(body as Record<string, unknown>) }
    try {
      const cwd = resolveGitCwd(manager, data)
      const result = write ? await checkedRepositoryWrite(cwd, data.version, () => fn(cwd, data)) : await fn(cwd, data)
      return { status: 200, body: result }
    } catch (e) {
      if (e instanceof GitWorkbenchError) return { status: e.status, body: { error: e.message, code: e.code } }
      return { status: 422, body: { error: (e as Error).message, code: 'git_failed' } }
    }
  }, apiToken)
  return {
    'GET /git/workbench': route(cwd => repositorySnapshot(cwd)),
    'GET /git/workbench/diff': route(async (cwd, data) => {
      const root = (await repositorySnapshot(cwd)).repository.cwd
      return { diff: await workbenchDiff(root, checkGitPath(root, data.path), data.staged === 'true') }
    }),
    'GET /git/workbench/history': route((cwd, data) => history(cwd, bounded(data.offset, 0, 100_000), bounded(data.limit, 50, 200))),
    'GET /git/workbench/compare': route(async (cwd, data) => {
      const from = validSha(data.from), to = validSha(data.to)
      const paths = (await gitRead(cwd, ['diff', '--name-only', '-z', from, to, '--'])).split('\0').filter(Boolean)
      for (const path of paths) checkGitPath(cwd, path)
      return { diff: await gitRead(cwd, ['diff', '--no-ext-diff', '--no-textconv', from, to, '--']) }
    }),
    'GET /git/workbench/commit': route(async (cwd, data) => {
      const sha = validSha(data.sha)
      const paths = (await gitRead(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha])).split('\0').filter(Boolean)
      for (const path of paths) checkGitPath(cwd, path)
      return { diff: await gitRead(cwd, ['show', '--format=fuller', '--no-ext-diff', '--no-textconv', sha, '--']) }
    }),
    'GET /git/workbench/branches': route(async cwd => ({ branches: (await gitRead(cwd, ['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(upstream:short)', 'refs/heads', 'refs/remotes'])).trim().split('\n').filter(Boolean).map(line => { const [name, sha, upstream] = line.split('\t'); return { name, sha, upstream } }), worktrees: await gitRead(cwd, ['worktree', 'list', '--porcelain']) })),
    'POST /git/workbench/stage': route(async (cwd, data) => {
      const { repository, changes } = await repositorySnapshot(cwd)
      cwd = repository.cwd
      const path = checkGitPath(cwd, data.path)
      const change = changes.find(c => c.path === path)
      if (!change) throw new GitWorkbenchError('file_missing', '文件变更已消失，请刷新')
      const unstage = data.unstage === true
      if (data.hunk !== undefined) {
        if (change.conflict || /[RC?]/.test(change.index + change.worktree)) throw new GitWorkbenchError('file_only', '此文件仅支持整文件暂存')
        const diff = await workbenchDiff(cwd, path, unstage)
        const parts = diff.split(/(?=^@@ )/m), header = parts.shift()!
        const hunk = Number(data.hunk)
        if (!Number.isInteger(hunk) || !parts[hunk] || /Binary files|GIT binary patch/.test(diff)) throw new GitWorkbenchError('invalid_hunk', '片段不可用，请刷新', 400)
        await gitRead(cwd, ['apply', '--cached', '--recount', ...(unstage ? ['--reverse'] : []), '-'], header + parts[hunk])
      } else if (unstage) {
        await gitRead(cwd, repository.head ? ['restore', '--staged', '--', path] : ['rm', '--cached', '--', path])
      } else {
        if (change.conflict) await gitRead(cwd, ['diff', '--check', '--', path])
        const files = [path, ...(change.originalPath ? [checkGitPath(cwd, change.originalPath)] : [])]
        await gitRead(cwd, ['--literal-pathspecs', 'add', '--', ...files])
      }
      return repositorySnapshot(cwd)
    }, true),
    'POST /git/workbench/commit': route((cwd, data) => commitStaged(cwd, String(data.message ?? '')), true),
    'POST /git/workbench/branch': route(async (cwd, data) => {
      const snapshot = await repositorySnapshot(cwd)
      if (snapshot.changes.length) throw new GitWorkbenchError('dirty_workspace', '工作区有未提交内容，请先处理后切换分支')
      const name = String(data.name ?? '')
      await gitRead(cwd, ['check-ref-format', '--branch', name])
      if (name.startsWith('-')) throw new GitWorkbenchError('invalid_branch', '无效分支名', 400)
      await gitRead(cwd, ['switch', ...(data.create === true ? ['-c'] : []), name])
      return repositorySnapshot(cwd)
    }, true),
    'POST /git/workbench/sync': route(async (cwd, data) => {
      const { repository, changes } = await repositorySnapshot(cwd)
      const remote = String(data.remote ?? '')
      if (!repository.remotes.some(r => r.name === remote)) throw new GitWorkbenchError('invalid_remote', '请选择有效远端', 400)
      const action = data.action
      if (!['fetch', 'pull', 'push'].includes(String(action))) throw new GitWorkbenchError('invalid_action', '无效同步操作', 400)
      if (action !== 'fetch') {
        if (changes.length) throw new GitWorkbenchError('dirty_workspace', '请先处理未提交变更')
        if (!repository.head || repository.branch === '(detached)') throw new GitWorkbenchError('detached_head', '请先选择本地分支')
        if (data.confirm !== true) throw new GitWorkbenchError('confirmation_required', '请确认同步目标', 400)
      }
      const ref = typeof data.ref === 'string' && data.ref ? data.ref : repository.branch
      if (action !== 'fetch') await gitRead(cwd, ['check-ref-format', '--branch', ref])
      if (ref.startsWith('-')) throw new GitWorkbenchError('invalid_ref', '无效远端分支', 400)
      await gitRead(cwd, action === 'fetch' ? ['fetch', remote] : action === 'pull' ? ['pull', '--ff-only', remote, ref] : ['push', '--set-upstream', remote, `HEAD:refs/heads/${ref}`])
      return repositorySnapshot(cwd)
    }, true),
  }
}
function bounded(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new GitWorkbenchError('invalid_page', '无效分页参数', 400)
  return n
}
export function validSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new GitWorkbenchError('invalid_sha', '缺少有效提交 SHA', 400)
  return value
}
