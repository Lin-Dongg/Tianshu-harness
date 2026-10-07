import { after, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createPersistentTaskState } from '../task-state-persist.js'
import { getEffectiveVerifications } from '../verification-attribution.js'

/**
 * task-state-persist 指纹一致性回归（8784b64b8 提交后审查 P1）。
 *
 * 缺陷：验证记录的 workspaceFingerprint（记录侧）用 ownership 文件集，
 * 而 validateEvents 的校验侧用 file_write 事件集——当 ownership 含 ledger
 * 事件之外的路径（plan draft 在 loop.ts:2195 只删事件不清 ownership，
 * autoOwnFromBaseline 自动认领同理）时两侧永不相等，本会话每条新验证
 * 记录后立即被判 stale，交付门禁恒 RED。
 */
const home = mkdtempSync(join(tmpdir(), 'task-state-persist-'))
process.env.RIVET_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}

function fixture() {
  const cwd = mkdtempSync(join(home, 'repo-'))
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test')
  writeFileSync(join(cwd, 'owned.ts'), 'original'); git(cwd, 'add', '--', 'owned.ts'); git(cwd, 'commit', '-qm', 'initial')
  return { cwd, baseline: { branch: 'main', head: git(cwd, 'rev-parse', 'HEAD'), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() } }
}

it('P1：ownership 含 ledger 外路径（plan draft）时，新验证不被判 stale', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'draft-drift', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  // 模拟 plan mode 写 draft 的残留形态：draft 进 ownership，但 ledger 事件被
  // loop.ts:2195 的 removeEventsByPath 删掉（或从未记录）——两侧集合就此分叉。
  state.ownership.registerOwned('draft.md')
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  const eff = getEffectiveVerifications(state.taskLedger.getEvents())
  assert.equal(eff.effective.length, 1, '验证不得因 ownership 有额外条目而被判 stale（记录侧/校验侧口径必须一致）')

  // 反向对照（8784b64b8 审查修复：原 staleSnapshotDropped===0 断言恒真、无防护力——
  // 该字段仅在传入 currentSnapshotRef 时递增）：file_write 事件集合变化后旧验证必
  // 被标 stale，证明判据仍在工作、上面的绿不是恒绿。
  writeFileSync(join(cwd, 'owned.ts'), 'next')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0, '新写事件必须使旧验证失效')
})

it('P1 对照：ownership 与 ledger 集合相同时（无外部条目）验证本就有效——防修复引入新失效', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'aligned', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1)
})

it('P1：正常会话经持久化往返后仍是 restored + verified（指纹自洽）', () => {
  const { cwd, baseline } = fixture(), first = createPersistentTaskState(cwd, 'roundtrip', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  const second = createPersistentTaskState(cwd, 'roundtrip', baseline)
  assert.equal(second.recovery, 'restored', '两侧同口径的正常会话恢复必须判 restored')
  assert.equal(second.taskLedger.getVerificationStatus(), 'verified')
})

it('W1-2：瞬态计划草稿的写入与释放都不得使代码验证失效', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'draft-neutral', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：代码验证已记录')

  // plan mode 里写草稿——tool-pipeline.ts:1726 的真实路径会落一条 file_write 事件。
  const draft = '.rivet/plans/draft-1700000000000.md'
  state.taskLedger.record({ type: 'file_write', path: draft })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '草稿不是代码证据：写草稿不得作废此前的代码验证',
  )

  // 退出 plan mode → loop.ts 的 removeEventsByPath 删掉草稿事件。
  state.taskLedger.removeEventsByPath(draft)
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '释放草稿同样不得连带作废验证（指纹口径须与草稿无关）',
  )

  // 反向对照：真正的代码写入仍必须使旧验证失效——证明上面的绿不是判据整体失灵。
  writeFileSync(join(cwd, 'owned.ts'), 'next')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0, '代码写入仍必须使旧验证失效')
})

it('T02：草稿释放后同 session 恢复——指纹口径不变、证据不降级、provenance 保留', () => {
  const { cwd, baseline } = fixture()
  const draft = '.rivet/plans/draft-1700000000002.md'
  const first = createPersistentTaskState(cwd, 'draft-restore', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  first.taskLedger.record({ type: 'file_write', path: draft })
  // 退出 plan mode 的释放动作（loop.ts::releasePlanModeArtifacts 的同一序列）。
  first.taskLedger.removeEventsByPath(draft)
  first.ownership.unregisterOwned(draft)

  const second = createPersistentTaskState(cwd, 'draft-restore', baseline)
  assert.equal(second.recovery, 'restored', '草稿往返不得让证据降级为 verification_stale')
  assert.equal(getEffectiveVerifications(second.taskLedger.getEvents()).effective.length, 1, '恢复后既有验证仍有效')
  assert.equal(second.ownership.isOwned('owned.ts'), true, 'provenance 保留：代码文件的归属不因草稿释放而丢')
})

it('T03：file_write / 带 path 的 git_action / adoption 多来源共用同一指纹口径——往返一致', () => {
  const { cwd, baseline } = fixture()
  const first = createPersistentTaskState(cwd, 'multi-source', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'git_action', path: 'staged.ts', meta: { command: 'git add staged.ts' } })
  first.ownership.adoptFiles(['adopted.ts'])
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(first.taskLedger.getEvents()).effective.length, 1, '前置：多来源共存时验证有效')

  const second = createPersistentTaskState(cwd, 'multi-source', baseline)
  assert.equal(second.recovery, 'restored', '记录侧与校验侧必须共用指纹口径（任一侧漏来源即在此变红）')
  assert.equal(getEffectiveVerifications(second.taskLedger.getEvents()).effective.length, 1)
  assert.equal(second.ownership.isOwned('adopted.ts'), true, 'adoption 的 provenance 必须随快照恢复')
})

it('T04：owned 内容变更使既有验证失效（执行上下文维度属 B 批 staleReason，未覆盖）', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'stale-on-change', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'v1')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1)

  writeFileSync(join(cwd, 'owned.ts'), 'v2')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    'owned 内容变化必须使旧验证失效——去掉这条，陈旧证据会被复用',
  )
})

/**
 * W2-1 交付门指纹治理：项目外写入不得毒化指纹。
 *
 * 缺陷：fingerprint()（task-state-persist.ts）对任何解析到 root 之外的路径
 * return null（与敏感路径共用分支），而 fingerprintPaths() 喂入全部 file_write
 * 事件路径 → 往仓库外写一个 fixture（/tmp 或兄弟目录）就使本会话所有验证被判
 * stale、交付门结构性 RED，且本会话无法摘除该事件。
 * 修法：out-of-project 路径排除出指纹输入集（与既有 plan 草稿同一机制），
 * fingerprint() 对 out-of-project 跳过而非作废；敏感路径语义不变（仍 fail-closed）。
 */
it('W2-1：仓库外写入不得毒化指纹——可交付内容的验证不被判 stale', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'out-of-root', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  // 两种越界形态：绝对路径（/tmp/...）与相对上跳（../...）——用户往项目外写 fixture 的真实形态。
  const abs = join(tmpdir(), 'task-state-outsider.js')
  state.taskLedger.record({ type: 'file_write', path: abs })
  state.ownership.registerOwned(abs)
  state.taskLedger.record({ type: 'file_write', path: '../outside-sibling.js' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '仓库外写入不是可交付内容，不得使可交付内容的验证被判 stale（否则会话结构性卡死）',
  )
})

it('W2-1 对照：排除越界不得把指纹修成恒不敏感——仓内内容变化仍使旧验证失效', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'out-of-root-guard', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'v1')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'file_write', path: join(tmpdir(), 'task-state-outsider.js') })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：排除越界后验证有效')

  writeFileSync(join(cwd, 'owned.ts'), 'v2')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    '仓内内容变化仍必须使旧验证失效——防修复把指纹修成恒不敏感',
  )
})

it('W2-1 边界：敏感路径（.env）保持 fail-closed——本次语义不变', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'sensitive-pin', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'file_write', path: '.env' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    '敏感路径不得被哈希（指纹不可用）→ 验证不作为有效证据（计划非目标：不放松该 fail-closed）',
  )
})
