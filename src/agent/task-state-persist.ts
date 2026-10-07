import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sessionsDir } from '../config/paths.js'
import { createTaskLedger, type TaskLedgerEvent } from './task-ledger.js'
import { createOwnershipLedger } from './ownership-ledger.js'
import { isTransientPlanDraftPath } from './plan-mode.js'
import { createWorktreeBaseline, type BaselineSnapshot } from './worktree-baseline.js'

interface TaskState {
  version: 1
  sessionId: string
  root: string
  baseline: BaselineSnapshot
  events: TaskLedgerEvent[]
  adopted: string[]
  fingerprint: string | null
}

function rootOf(cwd: string): string {
  try { return realpathSync(cwd) } catch { return resolve(cwd) }
}

/** 敏感路径（不得读取/哈希其内容）——与 fingerprint 的 fail-closed 同源。 */
const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.env|credentials\.)|private.*key|token|secret/i

/**
 * 交付指纹的路径归类。交付是 repo-scoped 概念：
 * - `out-of-project`：解析到 root 之外的路径**不可交付**（git 提交不了它），不参与
 *   指纹——否则往 /tmp 或兄弟目录写一个 fixture 就使本会话所有验证被判 stale、
 *   交付门结构性 RED，且本会话无工具摘除该事件（与 plan 草稿排除同一机制）。
 * - `sensitive`：不得读取/哈希其内容（fail-closed 保留，行为不变）。
 */
export function classifyFingerprintPath(root: string, file: string): 'in-project' | 'out-of-project' | 'sensitive' {
  const rel = relative(root, resolve(root, file)).replace(/\\/g, '/')
  if (isAbsolute(rel) || rel.startsWith('..')) return 'out-of-project'
  if (SENSITIVE_PATH_RE.test(rel)) return 'sensitive'
  return 'in-project'
}

function fingerprint(root: string, files: string[], isolated = false): string | null {
  const hash = createHash('sha256')
  for (const args of isolated ? [] : [['rev-parse', 'HEAD'], ['ls-files', '--stage', '-z']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    if (result.status !== 0) return null
    hash.update(result.stdout)
  }
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file), rel = relative(root, path)
    // 越界路径 = 不可交付：跳过而非作废（原实现与敏感路径共用 `return null`，是本缺陷根源）。
    if (classifyFingerprintPath(root, file) === 'out-of-project') continue
    if (SENSITIVE_PATH_RE.test(rel)) return null
    hash.update(file)
    try {
      const actual = realpathSync(path), inside = relative(root, actual)
      if (isAbsolute(inside) || inside.startsWith('..')) return null
      hash.update(readFileSync(actual))
    } catch { hash.update('missing') }
  }
  return hash.digest('hex')
}

/** 指纹输入集唯一口径：实际发生过的写（file_write 事件）+ 认领集。
 *  记录侧（workspaceFingerprint）与校验侧（validateEvents / 恢复校验）必须
 *  共用本函数——两侧口径分叉会让所有验证恒被标 stale（8784b64b8 审查 P1：
 *  ownership 含 ledger 事件之外的路径时，如 plan draft 残留、autoOwnFromBaseline
 *  自动认领，两个集合永不相等，交付门禁恒 RED）。
 *
 *  瞬态计划草稿除外：它不是代码证据。草稿的写入与释放（loop.ts
 *  releasePlanModeArtifacts 的 removeEventsByPath）都不得改变指纹——否则在
 *  plan mode 里写草稿会连带作废此前跑过的测试，且退出后 stale 标记仍留在
 *  那些验证事件上（8784b64b8 审查 P1 W1-2）。 */
function fingerprintPaths(events: ReadonlyArray<TaskLedgerEvent>, adopted: ReadonlySet<string> | readonly string[], root: string): string[] {
  const adoptedList = Array.isArray(adopted) ? adopted : [...adopted]
  // 越界路径（不可交付）不参与指纹——与 plan 草稿同为「不得影响指纹」的排除项。
  return [...events.filter(e => e.type === 'file_write' && e.path && !isTransientPlanDraftPath(e.path, root)).map(e => e.path!), ...adoptedList]
    .filter(p => classifyFingerprintPath(root, p) !== 'out-of-project')
}

/** A restored identity proves provenance; it never grants ownership of all dirty files. */
export function createPersistentTaskState(cwd: string, sessionId: string, fallback: BaselineSnapshot) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid task-state session identity')
  const root = rootOf(cwd)
  const path = resolve(sessionsDir(cwd), `${sessionId}.task-state.json`)
  let saved: TaskState | undefined
  try {
    const candidate = JSON.parse(readFileSync(path, 'utf8')) as TaskState
    if (candidate.version === 1 && candidate.sessionId === sessionId && candidate.root === root
      && Array.isArray(candidate.events) && candidate.events.every(event => event && ['file_write', 'verification', 'git_action'].includes(event.type) && (event.path === undefined || typeof event.path === 'string'))
      && Array.isArray(candidate.adopted) && candidate.adopted.every(file => typeof file === 'string')
      && typeof candidate.baseline?.head === 'string' && typeof candidate.baseline?.branch === 'string'
      && Array.isArray(candidate.baseline?.preExistingDirty) && Array.isArray(candidate.baseline?.preExistingUntracked)) saved = candidate
  } catch { /* old sessions and corrupt snapshots recover without manufactured evidence */ }
  const adopted = new Set(saved?.adopted ?? [])
  const taskLedger = createTaskLedger({ taskId: sessionId, validateEvents: events => {
    const verifications = events.filter(event => event.type === 'verification' && !event.meta?.stale && event.meta?.workspaceFingerprint)
    if (!verifications.length) return
    const current = fingerprint(root, fingerprintPaths(events, adopted, root))
    const snapshotCurrent = fingerprint(root, fingerprintPaths(events, adopted, root), true)
    for (const event of verifications) if (!current || event.meta?.workspaceFingerprint !== (event.meta?.verificationPhase === 'isolated' ? snapshotCurrent : current)) event.meta = { ...event.meta, stale: true }
  } })
  const baseline = createWorktreeBaseline(saved?.baseline ?? fallback)
  const ownership = createOwnershipLedger({ baseline, taskLedger })
  let valid = false
  if (saved) {
    valid = saved.fingerprint !== null && saved.fingerprint === fingerprint(root, fingerprintPaths(saved.events, saved.adopted, root))
    for (const event of saved.events) {
      taskLedger.record(event.type === 'verification' && !valid && event.meta?.verificationPhase !== 'isolated' ? { ...event, meta: { ...event.meta, stale: true } } : event)
    }
    ownership.autoOwnFromLedger()
    ownership.adoptFiles(saved.adopted)
  }
  const persist = () => {
    try {
      ownership.autoOwnFromLedger()
      const events = taskLedger.getEvents().filter(e => e.type === 'file_write' || e.type === 'verification' || e.type === 'git_action')
      const state: TaskState = { version: 1, root, sessionId, baseline: baseline.toSnapshot(), events: [...events], adopted: [...adopted], fingerprint: fingerprint(root, fingerprintPaths(events, adopted, root)) }
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
      renameSync(temporary, path)
    } catch { /* provenance persistence is best effort; absent proof stays unverified */ }
  }
  const record = taskLedger.record
  taskLedger.record = event => {
    if (event.type === 'file_write' && !isTransientPlanDraftPath(event.path, root)) {
      for (const previous of taskLedger.getVerifications()) previous.meta = { ...previous.meta, stale: true }
    }
    if (event.type === 'verification') {
      const current = fingerprint(root, fingerprintPaths(taskLedger.getEvents(), adopted, root), event.meta?.verificationPhase === 'isolated')
      const captured = event.meta && 'workspaceFingerprint' in event.meta ? event.meta.workspaceFingerprint : current
      event = { ...event, meta: { ...event.meta, workspaceFingerprint: captured, stale: event.meta?.stale || !captured || captured !== current } }
    }
    record(event)
    if (event.type === 'file_write' || event.type === 'verification' || event.type === 'git_action') persist()
  }
  taskLedger.captureVerificationFingerprint = (isolated, executionRoot) => fingerprint(executionRoot ?? root, fingerprintPaths(taskLedger.getEvents(), adopted, root), isolated)
  const adopt = ownership.adoptFiles
  ownership.adoptFiles = files => { const result = adopt(files); for (const file of files) adopted.add(file); persist(); return result }
  return { taskLedger, ownership, baseline, persist, recovery: saved ? valid ? 'restored' : 'verification_stale' : 'baseline_missing' }
}
