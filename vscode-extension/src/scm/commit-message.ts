/**
 * SCM 提交语生成 — 经 `rivet -p --json` headless 通路。
 *
 * 红线：插件不做 agent 逻辑——prompt 只是把 diff 交给内核，生成全在内核侧。
 * headless 单次执行不建持久会话，不污染 ~/.rivet/sessions/。
 */
import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import { resolveCliCommand } from '../sidecar/cli-command.js'

/** vscode.git 扩展 API 的最小结构面（避免引 git 扩展的 d.ts 依赖）。 */
interface GitRepository {
  rootUri: vscode.Uri
  inputBox: { value: string }
  state: {
    indexChanges: ReadonlyArray<{ uri: vscode.Uri }>
    workingTreeChanges: ReadonlyArray<{ uri: vscode.Uri }>
  }
}
interface GitApi {
  repositories: GitRepository[]
}

const DIFF_CHAR_CAP = 12_000
const HEADLESS_TIMEOUT_MS = 60_000

function getGitApi(): GitApi | null {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git')
  if (!ext) return null
  const exports = ext.isActive ? ext.exports : undefined
  try {
    return exports?.getAPI(1) ?? null
  } catch {
    return null
  }
}

function runGitDiff(cwd: string, staged: boolean): Promise<string> {
  return new Promise((resolve) => {
    const args = ['-c', 'core.quotePath=false', 'diff', '--no-color', ...(staged ? ['--cached'] : [])]
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.on('close', () => resolve(out))
    child.on('error', () => resolve(''))
  })
}

function runHeadless(cli: string, cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = resolveCliCommand(cli, ['-p', prompt, '--json'], cwd)
    const child = spawn(command.command, command.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('生成超时（60s）'))
    }, HEADLESS_TIMEOUT_MS)
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { err += c.toString() })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (e.code === 'ENOENT') reject(new Error('未找到 rivet CLI。请先安装（npm i -g tianshu-harness），或在设置 tianshu.cliPath 指定路径。'))
      else reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        // --json 输出单行 JSON {success, text, error?}
        const line = out.trim().split('\n').filter(Boolean).at(-1) ?? ''
        const parsed = JSON.parse(line) as { success: boolean; text: string; error?: string }
        if (parsed.success && parsed.text.trim()) resolve(parsed.text.trim())
        else reject(new Error(parsed.error || '内核未返回内容'))
      } catch {
        reject(new Error(`内核输出异常（exit ${code}）: ${(err || out).slice(0, 200)}`))
      }
    })
  })
}

export function registerCommitMessageCommand(context: vscode.ExtensionContext, getCliPath: () => Promise<string>): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tianshu.generateCommitMessage', async () => {
      const git = getGitApi()
      const repo = git?.repositories[0]
      if (!repo) {
        void vscode.window.showInformationMessage('请先打开 git 仓库')
        return
      }
      const cwd = repo.rootUri.fsPath

      // staged 优先；无 staged 时退回 working tree diff
      let diff = await runGitDiff(cwd, true)
      if (!diff.trim()) diff = await runGitDiff(cwd, false)
      if (!diff.trim()) {
        void vscode.window.showInformationMessage('没有待提交的改动')
        return
      }
      if (diff.length > DIFF_CHAR_CAP) {
        diff = diff.slice(0, DIFF_CHAR_CAP) + '\n…（diff 过长已截断）'
      }

      const prompt = [
        '请为以下 git diff 生成一条提交语。要求：',
        '- 首行 ≤50 字，中文，Conventional Commits 格式（feat/fix/refactor/docs/chore 等）',
        '- 如改动跨多个要点，空一行后给 2-3 个 bullet；单一改动只要首行',
        '- 只输出提交语本身，不要任何前缀、后缀、解释或代码块围栏',
        '',
        'diff:',
        diff,
      ].join('\n')

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: '天枢生成提交语…' },
        async () => {
          try {
            const cli = await getCliPath()
            const message = await runHeadless(cli, cwd, prompt)
            repo.inputBox.value = message
          } catch (err) {
            void vscode.window.showErrorMessage(`提交语生成失败: ${(err as Error).message}`)
          }
        },
      )
    }),
  )
}
