import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stableStringify } from '../api/stable-json.js'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { withAuth } from './route-auth.js'
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'
import { resolveGitCwd } from './git-workbench-routes.js'
import { GitWorkbenchError, repositorySnapshot, withRepositoryLock } from './git-workbench.js'
import { apiArgs, assertPrHead, gh, prDetail, prRepository, prThreads, repoFlag, prCreationPreview } from './git-pr-service.js'

export function buildGitPrRoutes(manager: RuntimeSessionManager, apiToken?: string): Record<string, RouteHandler> {
  const route = (operation: (cwd: string, data: Record<string, any>) => Promise<unknown>): RouteHandler => withAuth(async (body, params) => {
    const data = { ...params, ...(body as Record<string, unknown>) }
    try { return { status: 200, body: await operation(resolveGitCwd(manager, data), data) } }
    catch (e) { return { status: e instanceof GitWorkbenchError ? e.status : 422, body: { error: (e as Error).message, code: e instanceof GitWorkbenchError ? e.code : 'github_failed' } } }
  }, apiToken)
  return {
    'GET /git/workbench/pr-preview': route(async (cwd, data) => prCreationPreview(cwd, await prRepository(cwd, data.remote), data.base, data.head, data.headRepository)),
    'GET /git/workbench/prs': route(async (cwd, data) => {
      const repo = await prRepository(cwd, data.remote)
      await gh(cwd, ['auth', 'status', '--hostname', repo.host])
      const state = ['open', 'closed', 'merged', 'all'].includes(data.state) ? data.state : 'open'
      const prs = JSON.parse(await gh(cwd, ['pr', 'list', ...repoFlag(repo), '--state', state, '--limit', '100', '--json', 'number,title,state,isDraft,author,headRefName,headRefOid,url,reviewDecision']))
      return { repo, prs, limit: 100 }
    }),
    'GET /git/workbench/pr': route(async (cwd, data) => {
      const repo = await prRepository(cwd, data.remote), number = prNumber(data.number)
      const pr = await prDetail(cwd, repo, number)
      const [diff, threads] = await Promise.all([gh(cwd, ['pr', 'diff', String(number), ...repoFlag(repo)]), prThreads(cwd, repo, number)])
      // gh calls are separate requests; reject a mixed-revision page.
      if ((await prDetail(cwd, repo, number)).headRefOid !== pr.headRefOid) throw new GitWorkbenchError('stale_pr', 'PR 在读取期间变化，请刷新')
      return { repo, pr, diff, threads }
    }),
    'POST /git/workbench/pr-action': route(async (cwd, data) => {
      const repo = await prRepository(cwd, data.remote)
      const snapshot = await repositorySnapshot(cwd)
      return withRepositoryLock(snapshot.repository.commonDir, async () => {
        if (data.confirm !== true) throw new GitWorkbenchError('confirmation_required', '请先预览并确认外发内容', 400)
        return recordedOperation(`${repo.host}/${repo.fullName}`, data, async checkpoint => {
          if (data.action === 'create') {
            if (data.version !== (await repositorySnapshot(cwd)).repository.version) throw new GitWorkbenchError('stale_snapshot', '本地仓库已变化，请刷新')
            if (snapshot.changes.length) throw new GitWorkbenchError('dirty_workspace', '创建 PR 前请明确提交待发布内容；不会自动提交工作区')
            const base = text(data.base, 'base'), head = text(data.head, 'head'), title = text(data.title, 'title')
            const preview = await prCreationPreview(cwd, repo, base, head, data.headRepository)
            if (preview.headSha !== data.headSha || preview.baseSha !== data.baseSha) throw new GitWorkbenchError('stale_pr', '远端分支已变化，请重新预览创建范围')
            await checkpoint({ phase: 'sending' })
            const created = JSON.parse(await gh(cwd, [...apiArgs(repo, 'pulls'), '--method', 'POST', '--input', '-'], { base, head, head_repo: preview.headRepoName, title, body: String(data.body ?? ''), draft: data.draft === true }))
            return { url: created.html_url }
          }
          const number = prNumber(data.number), pr = await assertPrHead(cwd, repo, number, data.headSha)
          if (data.action === 'review') {
            if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(data.event)) throw new GitWorkbenchError('invalid_verdict', '无效审查结论', 400)
            const comments = (Array.isArray(data.comments) ? data.comments : []).map((c: Record<string, any>) => {
              if (!c.path || !Number.isInteger(c.line) || c.line < 1 || !['LEFT', 'RIGHT'].includes(c.side) || !c.body?.trim()) throw new GitWorkbenchError('invalid_anchor', '评论缺少有效行锚点', 400)
              return { path: c.path, line: c.line, side: c.side, body: c.body.trim() }
            })
            if (data.event === 'COMMENT' && !String(data.body ?? '').trim() && !comments.length) throw new GitWorkbenchError('empty_review', '审查内容不能为空', 400)
            await checkpoint({ phase: 'sending' })
            const result = JSON.parse(await gh(cwd, [...apiArgs(repo, `pulls/${number}/reviews`), '--method', 'POST', '--input', '-'], { commit_id: pr.headRefOid, event: data.event, body: String(data.body ?? ''), comments }))
            return { ok: true, reviewId: result.id }
          }
          if (data.action === 'merge') {
            if (pr.isDraft || pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus !== 'CLEAN') throw new GitWorkbenchError('merge_blocked', 'GitHub 尚未允许合并，请检查冲突、必需检查和审批')
            if (!['merge', 'squash', 'rebase'].includes(data.method)) throw new GitWorkbenchError('invalid_method', '无效合并方式', 400)
            await checkpoint({ phase: 'sending' })
            await gh(cwd, ['pr', 'merge', String(number), ...repoFlag(repo), `--${data.method}`, '--match-head-commit', pr.headRefOid])
            return { ok: true }
          }
          if (data.action === 'reply') {
            const commentId = prNumber(data.commentId)
            const threads = await prThreads(cwd, repo, number)
            if (!threads.nodes.some((t: Record<string, any>) => t.comments.nodes.some((c: Record<string, any>) => c.databaseId === commentId))) throw new GitWorkbenchError('thread_missing', '评论不属于当前 PR', 400)
            const reply = text(data.body, 'body')
            await checkpoint({ phase: 'sending' })
            return JSON.parse(await gh(cwd, [...apiArgs(repo, `pulls/${number}/comments/${commentId}/replies`), '--method', 'POST', '--input', '-'], { body: reply }))
          }
          if (data.action === 'resolve') {
            const threads = await prThreads(cwd, repo, number)
            if (!threads.nodes.some((t: Record<string, any>) => t.id === data.threadId)) throw new GitWorkbenchError('thread_missing', '线程不属于当前 PR', 400)
            const mutation = data.resolved === false ? 'unresolveReviewThread' : 'resolveReviewThread'
            const query = `mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{id isResolved}}}`
            await checkpoint({ phase: 'sending' })
            const result = JSON.parse(await gh(cwd, ['api', '--hostname', repo.host, 'graphql', '-f', `query=${query}`, '-f', `id=${data.threadId}`]))
            if (result.errors) throw new GitWorkbenchError('thread_failed', '线程更新失败，请刷新后核对', 422)
            return { ok: true }
          }
          throw new GitWorkbenchError('invalid_action', '无效 PR 操作', 400)
        })
      })
    }),
    'GET /git/workbench/pr-operation': route(async (cwd, data) => {
      const repo = await prRepository(cwd, data.remote)
      if (typeof data.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.operationId)) throw new GitWorkbenchError('operation_missing', '无效操作标识', 400)
      const path = join(rivetHome(), 'git-operations', `${data.operationId}.json`)
      const record = JSON.parse(await readFile(path, 'utf8'))
      if (record.repository !== `${repo.host}/${repo.fullName}`) throw new GitWorkbenchError('operation_scope', '操作不属于当前仓库', 403)
      if (record.state === 'completed') return { state: record.state, result: record.result }
      if (record.state === 'rejected') return { state: 'rejected', error: record.failure?.message ?? '执行前校验失败，请重新预览' }
      const desired = record.desired ?? {}
      let result: unknown
      if (record.action === 'merge') {
        const pr = await prDetail(cwd, repo, record.number)
        if (pr.state === 'MERGED' && pr.headRefOid === record.headSha) result = { ok: true }
      } else if (record.action === 'review') {
        const actor = JSON.parse(await gh(cwd, ['api', '--hostname', repo.host, 'user'])).login
        const reviews = JSON.parse(await gh(cwd, [...apiArgs(repo, `pulls/${record.number}/reviews`), '--paginate', '--slurp'])).flat()
        const matches = reviews.filter((r: Record<string, any>) => r.user?.login === actor && r.commit_id === record.headSha && r.body === desired.body && r.state === ({ COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as Record<string, string>)[desired.event] && r.submitted_at >= record.createdAt)
        if (matches.length === 1) {
          const actual = JSON.parse(await gh(cwd, [...apiArgs(repo, `pulls/${record.number}/reviews/${matches[0].id}/comments`), '--paginate', '--slurp'])).flat()
          const anchors = (items: Array<Record<string, any>>) => items.map(c => ({ path: c.path, line: c.line, side: c.side, body: c.body.trim() })).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
          if (stableStringify(anchors(actual)) === stableStringify(anchors(desired.comments ?? []))) result = { ok: true, reviewId: matches[0].id }
        }
      } else if (record.action === 'reply') {
        const actor = JSON.parse(await gh(cwd, ['api', '--hostname', repo.host, 'user'])).login
        const comments = JSON.parse(await gh(cwd, [...apiArgs(repo, `pulls/${record.number}/comments`), '--paginate', '--slurp'])).flat()
        const matches = comments.filter((c: Record<string, any>) => c.user?.login === actor && c.in_reply_to_id === desired.commentId && c.body === desired.body?.trim() && c.created_at >= record.createdAt)
        if (matches.length === 1) result = matches[0]
      } else if (record.action === 'resolve') {
        const threads = await prThreads(cwd, repo, record.number)
        if (threads.nodes.some((t: Record<string, any>) => t.id === desired.threadId && t.isResolved === (desired.resolved !== false))) result = { ok: true }
      } else if (record.action === 'push-fix' && record.localSha) {
        const pr = await prDetail(cwd, repo, record.number)
        if (pr.headRefOid === record.localSha) result = { ok: true, sha: record.localSha }
      } else if (record.action === 'create') {
        const prs = JSON.parse(await gh(cwd, ['pr', 'list', ...repoFlag(repo), '--head', desired.head, '--base', desired.base, '--state', 'open', '--json', 'url,title,body,isDraft']))
        const matches = prs.filter((p: Record<string, any>) => p.title === desired.title && p.body === desired.body && p.isDraft === desired.draft)
        if (matches.length === 1) result = { url: matches[0].url }
      }
      if (result) { await writeFile(path, JSON.stringify({ ...record, state: 'completed', result }), { mode: 0o600 }); return { state: 'completed', result } }
      return { state: 'uncertain', error: '暂不能唯一确认远端结果。请在 GitHub 核对，保留当前操作，勿重复发送。' }
    }),
  }
}
function prNumber(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new GitWorkbenchError('invalid_number', '无效 PR/评论编号', 400)
  return number
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new GitWorkbenchError('invalid_input', `缺少 ${name}`, 400)
  return value.trim()
}
export async function recordedOperation(repository: string, data: Record<string, any>, operation: (checkpoint: (fields: Record<string, unknown>) => Promise<void>) => Promise<unknown>): Promise<unknown> {
  const id = data.operationId
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new GitWorkbenchError('operation_missing', '缺少操作标识，请重新预览', 400)
  const dir = join(rivetHome(), 'git-operations'), path = join(dir, `${id}.json`)
  const fingerprint = createHash('sha256').update(stableStringify(data)).digest('hex')
  await mkdir(dir, { recursive: true })
  try {
    const old = JSON.parse(await readFile(path, 'utf8'))
    if (old.repository !== repository || old.action !== data.action || old.fingerprint !== fingerprint) throw new GitWorkbenchError('operation_mismatch', '操作目标或内容不一致')
    if (old.state === 'completed') return old.result
    // A response may have been lost after GitHub applied a write. Preserve the
    // operation instead of blindly issuing the same external write again.
    throw new GitWorkbenchError('operation_uncertain', `操作 ${id} 结果待核对，请刷新 PR 或在 GitHub 查看后再操作`)
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const desired = Object.fromEntries(['head', 'headRepository', 'base', 'title', 'body', 'draft', 'event', 'comments', 'commentId', 'threadId', 'resolved', 'jobId', 'artifactId'].filter(key => data[key] !== undefined).map(key => [key, data[key]]))
  let record: Record<string, any> = { id, fingerprint, repository, desired, action: data.action, number: data.number, headSha: data.headSha, state: 'pending', phase: 'preflight', createdAt: new Date().toISOString() }
  await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  const checkpoint = async (fields: Record<string, unknown>) => { record = { ...record, ...fields }; await writeFile(path, JSON.stringify(record), { mode: 0o600 }) }
  try {
    const result = await operation(checkpoint)
    await checkpoint({ state: 'completed', result })
    return result
  } catch (e) {
    await checkpoint({ state: record.phase === 'preflight' ? 'rejected' : 'uncertain', failure: { message: (e as Error).message } })
    throw e
  }
}
