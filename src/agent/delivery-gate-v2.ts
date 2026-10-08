/**
 * DeliveryGate v2 — 归因感知交付门 (B1-7)
 *
 * 基于 TaskLedger + OwnershipLedger + VerificationAttribution，
 * 生成结构化的交付门状态。使用 GREEN/YELLOW/RED 三态，对齐
 * Stable-State Regression Protocol 的状态机。
 *
 * GREEN  → 稳定态：owned files verified，可交付
 * YELLOW → 不确定态：external blockers，但 owned files verified，可带条件交付
 * RED    → 阻断态：owned failures 或 unverified owned files，禁止交付
 *
 * HEARTH 兼容：交付报告可作为 cycle_close 的证据沉积。
 * Songline 兼容：交付状态是 obligation fulfillment 的生态信号。
 *
 * @module delivery-gate-v2
 * @task B1-7
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnGitSync } from '../tools/spawn-git.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { VerificationAttribution, AttributionClass } from './verification-attribution.js'
import { getEffectiveVerifications, assessImpactedTestCoverage, isInvocationFailure } from './verification-attribution.js'
import { hasIsolatedComparison } from './verification-comparison.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import { classifyFingerprintPath } from './task-state-persist.js'
import type { VerificationMetadata } from '../tools/types.js'

// ─── External-file noise filtering (C-fix, session 803d897d) ───────────────
// 67 untracked .test-tmp files drowned the GREEN/YELLOW signal in every
// delivery report. External files from junk directories are noise, not
// blockers — filter them from display and summarize the count.

const JUNK_PATH_PREFIXES = [
  '.test-tmp/',
  '.rivet/',
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  'tmp/',
]

export function isJunkExternalPath(file: string): boolean {
  return JUNK_PATH_PREFIXES.some(prefix => file.startsWith(prefix))
}

/** Same canonicalization as the fingerprint layer (task-state-persist rootOf). */
function canonicalRoot(path: string): string { try { return realpathSync(path) } catch { return resolve(path) } }

/** Files matched by .gitignore (batched `git check-ignore`). Fails open to []. */
function gitIgnoredSubset(files: string[], cwd: string): Set<string> {
  if (files.length === 0) return new Set()
  try {
    const r = spawnGitSync(['check-ignore', '--stdin'], {
      cwd,
      input: files.join('\n'),
      encoding: 'utf-8',
      timeout: 5000,
    })
    // exit 0: some ignored; exit 1: none ignored; other: error → fail open
    if (r.status !== 0 && r.status !== 1) return new Set()
    return new Set(r.stdout.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

export interface ExternalNoiseSplit {
  /** Signal-bearing external files, in original order. */
  files: string[]
  /** Count of filtered junk/gitignored paths. */
  noiseCount: number
}

/**
 * Split external files into signal vs noise (junk dirs + gitignored paths).
 * cwd is used for the gitignore check; omit to use prefix rules only.
 */
export function filterExternalNoise(files: string[], cwd?: string): ExternalNoiseSplit {
  const prefixKept = files.filter(f => !isJunkExternalPath(f))
  const ignored = cwd ? gitIgnoredSubset(prefixKept, cwd) : new Set<string>()
  const kept = prefixKept.filter(f => !ignored.has(f))
  return { files: kept, noiseCount: files.length - kept.length }
}

export type GateState = 'GREEN' | 'YELLOW' | 'RED'

export interface DeliveryGateResult {
  state: GateState
  canDeliver: boolean
  isBlocked: boolean
  reason?: string
  blockingReason?: string
  ownedFileCount: number
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes — these were fixed. */
  supersededFailures: number
  /** Count of verifications dropped because their snapshotRef is stale
   *  (owned diff changed since they ran — ran on outdated code). */
  staleSnapshotDropped: number
  /** Count of verifications dropped on the workspace-fingerprint dimension
   *  (meta.stale === true) — ALL stale drops, distinct from snapshotRef staleness.
   *  典型病因两类：① 仓内再编辑（验证后 owned/仓内文件又被改写——正常开发循环的
   *  良性多数，可频繁非零）；② 指纹不可计算（敏感路径/非 git 工作区/4251eea67
   *  前台账的越界 owned 路径）。越界类病因的修复指引锚点见
   *  {@link outOfRootFingerprintPaths}。 */
  staleFingerprintDropped: number
  /** L4 指引锚点：owned/写入路径解析到仓库根之外的清单。仅在
   *  staleFingerprintDropped > 0 且确有越界路径时出现——deliver_task 据此输出
   *  「越界 → 旧台账指纹不可计算 → 移入仓内重跑验证」的修复指引，替代
   *  "no tests were run" 的误导形态。缺席 = 没有可行动的越界角度（仓内再编辑
   *  类判废只需重跑验证，不需要指引）。 */
  outOfRootFingerprintPaths?: string[]
  latestVerificationTotals?: { passed?: number; failed?: number; skipped?: number; countsReliable?: boolean; command: string; executionId?: string; timestamp?: number; durationMs?: number; executionComplete?: boolean }
  /** @deprecated use supersededFailures instead — renamed for semantic clarity. */
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  /** The verification attribution class that caused this gate state.
   *  Used by deliver_task to decide mechanical-change bypass. */
  attributionClass?: AttributionClass
  /** W1 回归防线: Meridian-impacted tests that exist but were never covered
   *  by a passed verification. Present when attributionClass === 'module_unverified'. */
  uncoveredImpactedTests?: string[]
  /** Impacted tests that no longer exist on disk (deleted/renamed) — recorded
   *  for the report, never blocking. */
  uncoverableImpactedTests?: string[]
}

export interface DeliveryReport {
  taskId: string
  state: GateState
  canDeliver: boolean
  ownedFiles: string[]
  ownedFileCount: number
  coOwnedFiles: string[]
  coOwnedFileCount: number
  historicalOwnedFiles: string[]
  historicalOwnedFileCount: number
  externalFiles: string[]
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes — these were fixed. */
  supersededFailures: number
  /** Count of verifications dropped because their snapshotRef is stale. */
  staleSnapshotDropped: number
  /** Count of verifications dropped on the workspace-fingerprint dimension
   *  (meta.stale === true) — all stale drops; 病因分类见 DeliveryGateResult。 */
  staleFingerprintDropped: number
  /** 越界 owned/写入路径清单 — see DeliveryGateResult.outOfRootFingerprintPaths。 */
  outOfRootFingerprintPaths?: string[]
  /** Latest verification pass/fail/skipped totals — for "声明即实测" echo in deliver_task output.
   *  Agents copy these numbers into delivery reports instead of guessing from memory. */
  latestVerificationTotals?: { passed?: number; failed?: number; skipped?: number; countsReliable?: boolean; command: string; executionId?: string; timestamp?: number; durationMs?: number; executionComplete?: boolean }
  /** @deprecated use supersededFailures instead — renamed for semantic clarity. */
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  blockingReason?: string
  /** The verification attribution class causing this gate state.
   *  Used by deliver_task to decide mechanical-change bypass. */
  attributionClass?: AttributionClass
  /** W1 回归防线: impacted tests never covered by a passed verification. */
  uncoveredImpactedTests?: string[]
  /** Impacted tests that no longer exist on disk (deleted/renamed). */
  uncoverableImpactedTests?: string[]
  /** Full attribution result for diagnostics */
  attributionSummary: string
}

/** W1 回归防线: inputs for impacted-test coverage assessment. Both provided by
 *  the caller (deliver_task) — the gate itself stays filesystem-free. */
export interface ModuleCoverageInput {
  repositoryRoot?: string
  /** Meridian blast radius tests (EvidenceTracker.impactedTests). */
  impactedTests: readonly string[]
  /** Existence probe — resolves relative paths against the session cwd. */
  testExists: (path: string) => boolean
}

export interface DeliveryGateV2 {
  /** Assess delivery readiness, optionally with external verification metadata,
   *  current dirty files, and the current VSW snapshotRef (drops stale snapshot
   *  verifications when provided). */
  assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryGateResult
  /** Full structured report suitable for cycle_close deposit */
  getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryReport
}

/**
 * Track 3 门禁合一：收敛检测 L2+ 时基于权威门禁状态生成结束/修复指引。
 * GREEN → 指示输出最终摘要结束回合；RED → 指示阻断项与最短下一步；
 * YELLOW → 可带条件交付。返回的字符串作为 system-reminder 注入。
 */
export function buildGateConvergenceHint(
  gate: Pick<DeliveryGateResult, 'state' | 'reason' | 'blockingReason' | 'shortestNextStep' | 'attributionClass'>,
  depthLayer?: import('../context/task-contract.js').TaskDepthLayer,
): string {
  const depthSuffix = depthLayer && depthLayer !== 'unit'
    ? `\n[depth=${depthLayer}] 验证必须覆盖跨模块边界，不仅仅是单函数行为。`
    : ''
  if (gate.state === 'GREEN') {
    return '交付门禁 GREEN：所有 owned 文件已验证。请输出最终摘要并结束回合，不再调用工具。' + depthSuffix
  }
  if (gate.state === 'RED') {
    const lines = [`交付门禁 RED：${gate.blockingReason ?? gate.reason ?? 'owned 文件存在未验证或失败项。'}`]
    lines.push('请先解决阻断项再继续；若无法解决，明确报告阻断原因后结束回合。')
    if (gate.shortestNextStep) lines.push(`方向：${gate.shortestNextStep}`)
    return lines.join('\n') + depthSuffix
  }
  // YELLOW — differentiate no_test_infra from transient external blocks
  if (gate.attributionClass === 'module_unverified') {
    return `交付门禁 YELLOW（波及面未验证）：${gate.reason ?? '改动波及的测试从未被任何 passed 验证覆盖。'}\n引入回归是最常见的交付失败——请运行上述受波及测试（或一次 full-scope 验证）后再交付；commit=true 会被硬拦。` + depthSuffix
  }
  if (gate.attributionClass === 'no_test_infra') {
    return `交付门禁 YELLOW（测试基础设施缺失）：${gate.reason ?? '项目无可自动检测的测试框架。'}\n\n不要反复重试 run_tests——它每次都会以同样原因受阻。应向用户报告具体缺失项，并询问是否需要协助搭建测试框架，或用 bash 运行替代验证后交付。` + depthSuffix
  }
  return `交付门禁 YELLOW：${gate.reason ?? '存在外部阻塞，owned 文件已验证。'}\n可带条件交付：输出最终摘要并明确标注 caveat，然后结束回合。${depthSuffix}`
}

export function createDeliveryGateV2(opts: {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  attribution: VerificationAttribution
  /** 仓库根（会话 cwd）。提供时启用越界路径诊断（outOfRootFingerprintPaths）。 */
  repoRoot?: string
}): DeliveryGateV2 {
  const { taskLedger, ownership, attribution } = opts
  // 与指纹层（task-state-persist rootOf）同口径：root 需 canonical，否则 macOS
  // /var→/private/var 符号链接会把仓内绝对路径误判成越界。
  const repoRoot = opts.repoRoot ? canonicalRoot(opts.repoRoot) : undefined

  const emptyDiagnostics = {
    supersededFailures: 0,
    staleFailureCandidates: 0,
    staleSnapshotDropped: 0,
    staleFingerprintDropped: 0,
    toolInvocationFailureCandidates: [] as string[],
  }

  // Single source of truth — the gate used to carry its own copy of this
  // predicate, which drifted from the attribution module's semantics.
  function isToolInvocationFailure(v: VerificationMetadata): boolean {
    return isInvocationFailure(v)
  }

  // L4 观测（交付门指纹治理计划，4251eea67 审查 P2）：stale 丢弃与「owned/写入路径
  // 在仓库根之外」并存时给出越界清单，供 deliver_task 输出修复指引——否则病因被报成
  // "no tests were run"。与计数分工：staleFingerprintDropped 统计所有 stale 丢弃
  // （仓内再编辑是良性多数），本字段只在确有越界路径时出现，把指引锚在可行动的那一类。
  // 失效方向：宁可缺席（少指引）也不在纯仓内判废时误指越界。
  function outOfRootFingerprintPaths(staleFingerprintDropped: number): string[] | undefined {
    if (!repoRoot || staleFingerprintDropped === 0) return undefined
    const candidates = new Set<string>()
    for (const event of taskLedger.getEvents()) {
      if (event.type === 'file_write' && event.path) candidates.add(event.path)
    }
    for (const file of ownership.getOwnedFiles()) candidates.add(file)
    const outside = [...candidates].filter(p => classifyFingerprintPath(repoRoot, p) === 'out-of-project').sort()
    return outside.length > 0 ? outside : undefined
  }

  function verificationDiagnostics(verifications: VerificationMetadata[], supersededFailures: number, staleSnapshotDropped: number, staleFingerprintDropped: number): Pick<DeliveryGateResult, 'supersededFailures' | 'staleFailureCandidates' | 'staleSnapshotDropped' | 'staleFingerprintDropped' | 'toolInvocationFailureCandidates' | 'shortestNextStep' | 'outOfRootFingerprintPaths'> {
    const invocationFailures = verifications.filter(isToolInvocationFailure)
    const shortestNextStep = invocationFailures
      .map(v => v.recommendedCommand ?? v.resolvedCommand)
      .find((cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0)
    const outOfRoot = outOfRootFingerprintPaths(staleFingerprintDropped)
    return {
      supersededFailures,
      staleFailureCandidates: supersededFailures,
      staleSnapshotDropped,
      staleFingerprintDropped,
      toolInvocationFailureCandidates: invocationFailures.map(v => v.command),
      ...(shortestNextStep ? { shortestNextStep } : {}),
      ...(outOfRoot ? { outOfRootFingerprintPaths: outOfRoot } : {}),
    }
  }

  function getGateFiles(currentDirtyFiles?: string[]): {
    ownedFilesForGate: string[]
    coOwnedFiles: string[]
    historicalOwnedFiles: string[]
    externalFiles: string[]
  } {
    const allOwnedFiles = ownership.getOwnedFiles()
    const allCoOwnedFiles = ownership.getCoOwnedFiles()
    const allExternalFiles = ownership.getExternalFiles(currentDirtyFiles)
    if (!currentDirtyFiles) {
      return {
        ownedFilesForGate: allOwnedFiles,
        coOwnedFiles: allCoOwnedFiles,
        historicalOwnedFiles: [],
        externalFiles: allExternalFiles,
      }
    }

    const currentDirty = new Set(currentDirtyFiles)
    const ownedFilesForGate = allOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const coOwnedFiles = allCoOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const historicalOwnedFiles = allOwnedFiles.filter(f => !currentDirty.has(f)).sort()
    const externalFiles = allExternalFiles.filter(f => currentDirty.has(f)).sort()
    return { ownedFilesForGate, coOwnedFiles, historicalOwnedFiles, externalFiles }
  }

  function assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryGateResult {
    const result = assessVerification(externalVerifications, currentDirtyFiles, currentSnapshotRef, moduleCoverage)
    if (ownership.isBaselineComplete()) return result
    return {
      ...result,
      state: result.state === 'GREEN' ? 'YELLOW' : result.state,
      reason: `${result.reason ?? ''}\n该工作区不是 git 仓库（或归属基线未能建立）：无法建立归属基线，也无法提交——deliver_task(commit=true) 会失败。文件改动仍然生效；验证与覆盖要求仍需满足。`.trim(),
    }
  }

  function assessVerification(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryGateResult {
    const { ownedFilesForGate: ownedFiles, coOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)

    // Check ownership health for unclassified dirty files
    if (currentDirtyFiles) {
      const health = summarizeOwnershipHealth({
        ownedFiles,
        coOwnedFiles,
        externalFiles,
        dirtyFiles: currentDirtyFiles,
      })
      if (health.warningLines.length > 0) {
        // Unclassified dirty files → YELLOW with caveat
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${health.warningLines.length} dirty file(s) have no ownership classification. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: externalVerifications.length,
          ...emptyDiagnostics,
        }
      }
    }

    // Use effective verifications (deduplicated by supersession + VSW staleness)
    const rawVerifications = taskLedger.getVerifications()
    const { effective: ownedVerifications, supersededFailures, staleSnapshotDropped, staleFingerprintDropped } = getEffectiveVerifications(rawVerifications, currentSnapshotRef)

    // Combine owned + external verifications for full picture
    const allVerifications = [
      ...ownedVerifications,
      ...externalVerifications,
    ]
    const diagnostics = verificationDiagnostics(allVerifications, supersededFailures, staleSnapshotDropped, staleFingerprintDropped)

    // 层 1a: latest verification totals for "声明即实测" echo
    const _lv = allVerifications.length > 0 ? allVerifications[allVerifications.length - 1] : undefined
    const latestVerificationTotals = _lv
      ? { passed: _lv.passed, failed: _lv.failed, skipped: _lv.skipped, countsReliable: _lv.countsReliable, command: _lv.command, executionId: _lv.executionId, timestamp: _lv.timestamp, durationMs: _lv.durationMs, executionComplete: _lv.coverage?.executionComplete }
      : undefined

    // Nothing to deliver
    if (ownedFiles.length === 0) {
      const hasExternals = externalFiles.length > 0
      return {
        state: 'GREEN',
        canDeliver: true,
        isBlocked: false,
        reason: hasExternals
          ? `No owned files modified. ${externalFiles.length} external dirty file(s) present but excluded from delivery scope.`
          : 'No file modifications.',
        ownedFileCount: 0,
        externalFileCount: externalFiles.length,
        verificationCount: allVerifications.length,
        ...diagnostics,
      latestVerificationTotals,
      }
    }

    // Check attribution
    const aggregate = attribution.getAggregateAttribution(allVerifications)

    // Negative evidence never cancels coverage obligations. Preserve existing
    // RED conclusions; missing infrastructure only remains a caveat when no
    // existing impacted test is awaiting verification.
    const coverage = moduleCoverage && moduleCoverage.impactedTests.length > 0
      && aggregate.attribution !== 'unverified'
      && aggregate.attribution !== 'owned_failure'
      ? assessImpactedTestCoverage(moduleCoverage.impactedTests, allVerifications, moduleCoverage.testExists, moduleCoverage.repositoryRoot)
      : undefined
    if (coverage?.failed?.length) {
      // 外部阻塞 / 未归因的全量失败降级（2026-10-07 对齐，2026-10-08 收紧）：
      // 受影响测试的失败若无法归因到本次改动（`unattributed_failure`）或来自外部
      // 阻塞（`external_blocked`），在共享工作区里很可能是其他会话的在途改动污染了
      // 全量 run_tests（假红）。但「聚合归因 ∈ {unattributed_failure, external_blocked}」
      // 本身不构成证据：任何 full-scope 失败在归因器里恒为 unattributed_failure
      // （owned_failure 只来自 targeted owned 失败），单会话干净工作区里「自己改坏
      // impacted test、只跑了全量」同样命中——判据宽于理据会让真失败在报告层搭便车
      // 成 YELLOW（canDeliver=true，语义停在中间态：gate 放行而 commit 通路 W1 硬拦）。
      // 因此降级要求「失败非本会话造成」的正向证据（失效方向选收紧：宁可少降级、
      // 无证据保持 RED，也不错放行——RED 文案指引隔离单跑配对取证的正确出路）：
      //   ① 工作区确有外部在途改动（externalFiles 非空）——共享工作区污染理据成立；
      //   ② 存在隔离单跑配对（isolated 通过 + integration 失败、同 comparisonId /
      //      snapshotRef，判据复用 verification-comparison.ts）——owned diff 隔离
      //      可过而集成失败，失败指向外部集成差异。
      // 覆盖**义务本身不豁免**（守卫 8784b64b8「覆盖义务不受聚合归因影响」不变，
      // 只放宽 `failed` 这一支的硬 RED）；本会话自己的回归仍走 `owned_failure` 分支
      // 硬拦。配对成立时失败文件本就不计入 coverage.failed、聚合转
      // integration_conflict（W1 不拦）——那是单会话自证清白的标准出路。
      const unattributedOrExternal = aggregate.attribution === 'unattributed_failure' || aggregate.attribution === 'external_blocked'
      const hasExternalEvidence = externalFiles.length > 0
        || allVerifications.some(v => hasIsolatedComparison(v, allVerifications))
      const externallyBlocked = unattributedOrExternal && hasExternalEvidence
      const reason = externallyBlocked
        ? `受影响测试失败，但聚合归因未指向本次改动（${aggregate.attribution}）：${coverage.failed.join(', ')}。${externalFiles.length > 0 ? `共享工作区的外部在途改动（${externalFiles.length} 个）可能造成假红` : '隔离单跑配对证明 owned diff 隔离通过、集成失败，失败指向外部集成差异'}——可降级 scoped 交付，但须在报告点名。`
        : unattributedOrExternal
          ? `Required impacted tests failed: ${coverage.failed.join(', ')}。聚合归因未指向本次改动（${aggregate.attribution}），但无外部在途改动、无隔离单跑配对——外部污染理据不成立，按真失败处理。若确信失败来自外部并发改动，先用隔离单跑配对（isolated/integration 同 comparisonId）取证再交付。`
          : `Required impacted tests failed: ${coverage.failed.join(', ')}`
      return {
        state: externallyBlocked ? 'YELLOW' : 'RED',
        canDeliver: externallyBlocked,
        isBlocked: !externallyBlocked,
        reason,
        ownedFileCount: ownedFiles.length, externalFileCount: externalFiles.length,
        verificationCount: allVerifications.length, ...diagnostics, latestVerificationTotals,
        attributionClass: 'module_unverified', uncoveredImpactedTests: coverage.failed,
        // RED 臂补 blockingReason/currentBlockingFailure：deliver_task(commit=true)
        // 的 RED Recovery 段只打印这两个字段，缺了它们失败清单在提交路径不可见。
        ...(externallyBlocked ? {} : {
          blockingReason: reason,
          currentBlockingFailure: `Required impacted tests failed: ${coverage.failed.join(', ')}`,
        }),
      }
    }
    if (coverage && coverage.uncovered.length > 0) {
      const sample = coverage.uncovered.slice(0, 5)
      return {
        state: 'YELLOW',
        canDeliver: true,
        isBlocked: false,
        reason: `${ownedFiles.length} owned file(s) lack coverage for ${coverage.uncovered.length} impacted test file(s) (Meridian blast radius): ${sample.join(', ')}${coverage.uncovered.length > sample.length ? ` (+${coverage.uncovered.length - sample.length} more)` : ''}. Run these tests with a supported runner and record complete per-file evidence; command targets and full-scope labels alone do not prove execution.`,
        ownedFileCount: ownedFiles.length,
        externalFileCount: externalFiles.length,
        verificationCount: allVerifications.length,
        ...diagnostics,
        latestVerificationTotals,
        attributionClass: 'module_unverified',
        uncoveredImpactedTests: coverage.uncovered,
        ...(coverage.uncoverable.length > 0 ? { uncoverableImpactedTests: coverage.uncoverable } : {}),
      }
    }

    switch (aggregate.attribution) {
      case 'verified': {
        if (coverage && coverage.uncoverable.length > 0) {
          // 留痕不阻断：已删/重命名的测试只出现在报告里
          return {
            state: 'GREEN',
            canDeliver: true,
            isBlocked: false,
            reason: `${ownedFiles.length} owned file(s) verified. Ready to deliver. (${coverage.uncoverable.length} impacted test path(s) no longer exist — deleted/renamed, excluded from coverage check.)`,
            ownedFileCount: ownedFiles.length,
            externalFileCount: externalFiles.length,
            verificationCount: allVerifications.length,
            ...diagnostics,
            latestVerificationTotals,
            uncoverableImpactedTests: coverage.uncoverable,
          }
        }
        return {
          state: 'GREEN',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified. Ready to deliver.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }
      }

      case 'external_blocked':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified, but external verification blocked: ${aggregate.reason}. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'no_test_infra':
        // Project has no test framework / test files — not a transient error,
        // but a structural gap. YELLOW: deliverable with specific guidance to
        // the user about setting up testing. Do NOT keep retrying run_tests —
        // it will keep failing the same way.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `测试基础设施缺失：${aggregate.reason}\n\n该项目无可自动检测的测试框架或测试文件。run_tests 不会自动生效，继续重试不会改变结果。请向用户说明具体缺失项和下一步。`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          attributionClass: 'no_test_infra',
        }

      case 'owned_failure':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: aggregate.reason,
          blockingReason: `Owned verification failed. Fix failures before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          currentBlockingFailure: aggregate.reason,
          attributionClass: 'owned_failure',
        }

      case 'verification_timeout':
        // Timeout means we learned nothing about the code, and the underlying
        // process may still be running/mutating the workspace. Non-blocking for
        // delivery (same safety posture as before) but with honest guidance —
        // the previous text told the model this was "not a code failure, re-run",
        // which is wrong on both counts.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${aggregate.reason}\n\nNothing was verified by this run. Do not assume the code is broken, and do not blindly re-run: confirm the workspace is settled (git status / no orphaned process still writing) before re-verifying with a bounded command. You may still deliver if you have independently verified correctness.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          attributionClass: 'verification_timeout',
        }

      case 'tool_invocation_failure':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${aggregate.reason}\n\nThis is a tool invocation issue — the runner did not execute. Re-run with the recommended command. You may still deliver if you have independently verified correctness.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'unattributed_failure':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) are not directly implicated, but verification has unresolved full-suite failure: ${aggregate.reason}. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'integration_conflict':
        // Phase B failed on current HEAD but the owned diff passed in isolation
        // (Phase A). Concurrent-change conflict — advisory, not this session's
        // fault. Deliverable with a rebase/coordinate caveat.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified in isolation, but integration on current HEAD conflicts: ${aggregate.reason}`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'unverified':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: `${ownedFiles.length} owned file(s) modified but unverified.`,
          blockingReason: `Run verification before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          currentBlockingFailure: `${ownedFiles.length} owned file(s) modified but unverified.`,
          attributionClass: 'unverified',
        }

      default:
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: 'Unknown verification state.',
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          currentBlockingFailure: 'Unknown verification state.',
          attributionClass: 'unverified',
        }
    }
  }

  function getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryReport {
    const result = assess(externalVerifications, currentDirtyFiles, currentSnapshotRef, moduleCoverage)
    const { ownedFilesForGate, coOwnedFiles, historicalOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)
    return {
      taskId: taskLedger.getTaskId(),
      state: result.state,
      canDeliver: result.canDeliver,
      ownedFiles: ownedFilesForGate,
      ownedFileCount: result.ownedFileCount,
      coOwnedFiles,
      coOwnedFileCount: coOwnedFiles.length,
      historicalOwnedFiles,
      historicalOwnedFileCount: historicalOwnedFiles.length,
      externalFiles,
      externalFileCount: result.externalFileCount,
      verificationCount: result.verificationCount,
      supersededFailures: result.supersededFailures,
      staleSnapshotDropped: result.staleSnapshotDropped,
      staleFingerprintDropped: result.staleFingerprintDropped,
      outOfRootFingerprintPaths: result.outOfRootFingerprintPaths,
      latestVerificationTotals: result.latestVerificationTotals,
      staleFailureCandidates: result.staleFailureCandidates,
      toolInvocationFailureCandidates: result.toolInvocationFailureCandidates,
      currentBlockingFailure: result.currentBlockingFailure,
      shortestNextStep: result.shortestNextStep,
      blockingReason: result.blockingReason,
      attributionClass: result.attributionClass,
      uncoveredImpactedTests: result.uncoveredImpactedTests,
      uncoverableImpactedTests: result.uncoverableImpactedTests,
      attributionSummary: result.reason ?? 'No attribution available.',
    }
  }

  return { assess, getReport }
}
