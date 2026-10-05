import { runGhCapture, type GhResult } from './gh-cli.js'
import { gitRead, GitWorkbenchError, repositorySnapshot } from './git-workbench.js'
export interface GithubRepository { host: string; owner: string; name: string; fullName: string }
export function githubRemote(url: string): GithubRepository {
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!match || !/^[\w.-]+$/.test(match[1]!) || !/^[\w.-]+$/.test(match[2]!) || !/^[\w.-]+$/.test(match[3]!)) throw new GitWorkbenchError('unsupported_remote', '请选择有效的 GitHub SSH/HTTPS 远端', 400)
  return { host: match[1]!, owner: match[2]!, name: match[3]!, fullName: `${match[2]}/${match[3]}` }
}
export async function prRepository(cwd: string, remote: unknown): Promise<GithubRepository> {
  const { repository } = await repositorySnapshot(cwd)
  if (typeof remote !== 'string' || !repository.remotes.some(r => r.name === remote)) throw new GitWorkbenchError('remote_missing', '请选择 GitHub 远端', 400)
  return githubRemote((await gitRead(cwd, ['remote', 'get-url', remote])).trim())
}
export async function gh(cwd: string, args: string[], input?: unknown): Promise<string> {
  const result = await runGhCapture(args, cwd, input === undefined ? undefined : JSON.stringify(input), 60_000)
  if (!result.ok) throw ghError(result)
  return result.stdout
}
export function ghError(result: GhResult): GitWorkbenchError {
  const message = result.stderr.trim() || 'GitHub 请求失败'
  const code = /ENOENT|not found|not recognized/i.test(message) && result.code === null ? 'gh_missing'
    : /auth login|not logged|authentication|HTTP 401/i.test(message) ? 'gh_unauthenticated'
      : /HTTP 403|HTTP 404|permission|Could not resolve to a Repository/i.test(message) ? 'github_permission'
        : /timeout|timed out|ETIMEDOUT|ENOTFOUND|connection/i.test(message) ? 'github_network' : 'github_failed'
  return new GitWorkbenchError(code, message, 422)
}
export const repoFlag = (repo: GithubRepository) => ['--repo', `${repo.host}/${repo.fullName}`]
export const apiArgs = (repo: GithubRepository, path: string) => ['api', '--hostname', repo.host, `repos/${repo.fullName}/${path}`]
export async function prDetail(cwd: string, repo: GithubRepository, number: number): Promise<Record<string, any>> {
  return JSON.parse(await gh(cwd, ['pr', 'view', String(number), ...repoFlag(repo), '--json', 'number,title,body,url,state,isDraft,author,headRefName,headRefOid,baseRefName,baseRefOid,headRepository,headRepositoryOwner,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,commits,comments']))
}
export async function assertPrHead(cwd: string, repo: GithubRepository, number: number, expected: unknown) {
  const pr = await prDetail(cwd, repo, number)
  if (typeof expected !== 'string' || !expected || expected !== pr.headRefOid) throw new GitWorkbenchError('stale_pr', 'PR 已有新提交，请刷新并重新审查')
  if (pr.state !== 'OPEN') throw new GitWorkbenchError('pr_closed', 'PR 已关闭或合并')
  return pr
}
export async function prCreationPreview(cwd: string, repo: GithubRepository, base: unknown, head: unknown, headRepository?: unknown) {
  if (typeof base !== 'string' || typeof head !== 'string' || !base || !head || base.startsWith('-') || head.startsWith('-')) throw new GitWorkbenchError('invalid_ref', '请选择 base/head 分支', 400)
  const [owner, branch] = head.includes(':') ? head.split(':') : [repo.owner, head]
  if (!owner || !branch || head.split(':').length > 2) throw new GitWorkbenchError('invalid_head', 'Head 应为 branch 或 owner:branch', 400)
  const fullName = typeof headRepository === 'string' && headRepository ? headRepository : `${owner}/${repo.name}`
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || fullName.split('/')[0] !== owner) throw new GitWorkbenchError('invalid_head', 'Head 仓库必须与 head 分支的 owner 一致', 400)
  const target = { ...repo, owner, name: fullName.split('/')[1]!, fullName }
  const [baseCommit, headCommit] = await Promise.all([
    gh(cwd, apiArgs(repo, `commits/${encodeURIComponent(base)}`)).then(value => JSON.parse(value)),
    gh(cwd, apiArgs(target, `commits/${encodeURIComponent(branch)}`)).then(value => JSON.parse(value)),
  ])
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit.sha) || !/^[a-f0-9]{40,64}$/.test(headCommit.sha)) throw new GitWorkbenchError('head_unavailable', '无法确认远端分支，请先推送', 422)
  const diff = await gh(cwd, [...apiArgs(repo, `compare/${baseCommit.sha}...${headCommit.sha}`), '-H', 'Accept: application/vnd.github.diff'])
  return { baseSha: baseCommit.sha, headSha: headCommit.sha, headRepository: target.fullName, headRepoName: target.name, diff }
}
export async function prThreads(cwd: string, repo: GithubRepository, number: number) {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line originalLine diffSide startLine startDiffSide comments(first:100){nodes{databaseId body author{login} createdAt commit{oid}} pageInfo{hasNextPage}}}}}}}`
  const result = JSON.parse(await gh(cwd, ['api', '--hostname', repo.host, 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${number}`]))
  if (result.errors) throw new GitWorkbenchError('threads_failed', '审查线程读取失败', 422)
  return result.data.repository.pullRequest.reviewThreads
}
