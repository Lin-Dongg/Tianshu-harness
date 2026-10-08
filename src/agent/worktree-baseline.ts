/**
 * WorktreeBaseline — 任务启动基线 (B1-2)
 *
 * 在任务启动时采集 git/worktree 的初始状态快照。
 * 用于区分"当前任务的改动"与"任务启动前已存在的改动"。
 *
 * 核心语义：pre-existing dirty/untracked files 不属于当前任务，
 * 不应被 scoped commit/stash/undo 包含。
 *
 * HEARTH 兼容：baselineHash 可作为 cycle_open 的输入之一。
 * Songline 兼容：外部文件列表可被 obligation engine 读取，
 *   帮助 agent 区分"我的义务范围"与"外部世界状态"。
 *
 * @module worktree-baseline
 * @task B1-2
 */

import { createHash } from 'node:crypto'

export interface BaselineSnapshot {
  complete?: boolean
  branch: string
  head: string
  preExistingDirty: string[]
  preExistingUntracked: string[]
  capturedAt: number
}

export interface WorktreeBaseline {
  getBranch(): string
  getHead(): string
  /** Is this file pre-existing (not owned by current task)? */
  isExternal(filePath: string | null | undefined): boolean
  /** 基线是否完整建立（git 可用且成功捕获）。不完整时 isExternal 恒真、无法区分
   *  外部性——调用方据此不要把「本会话 ledger 写过」的铁证降级为 co-owned（issue #369）。 */
  isComplete(): boolean
  /** 原地替换快照（会话中途 git init 的恢复入口，交付硬门现场重采用）。
   *  只换数据不换对象——ownership-ledger / task-state 持久化持有的引用随即按
   *  新基线判定，persist() 的 toSnapshot() 也落新基线（resume 不再继承 incomplete）。 */
  replaceSnapshot(next: BaselineSnapshot): void
  /** All external files (dirty + untracked), deduplicated and sorted */
  getExternalFiles(): string[]
  getExternalDirtyCount(): number
  getExternalUntrackedCount(): number
  /** SHA-256 hash of structural identity (branch + head + external files, NOT capturedAt) */
  getBaselineHash(): string
  toSnapshot(): BaselineSnapshot
}

export function createWorktreeBaseline(initial: BaselineSnapshot): WorktreeBaseline {
  let snapshot = initial
  let externalSet = new Set([
    ...snapshot.preExistingDirty,
    ...snapshot.preExistingUntracked,
  ])

  let _baselineHash: string | null = null

  function computeBaselineHash(): string {
    // Structural identity only — capturedAt excluded so hash is stable for
    // the same git state regardless of when it was captured.
    const canonical = JSON.stringify({
      branch: snapshot.branch,
      head: snapshot.head,
      preExistingDirty: [...snapshot.preExistingDirty].sort(),
      preExistingUntracked: [...snapshot.preExistingUntracked].sort(),
    })
    return createHash('sha256').update(canonical).digest('hex')
  }

  function getBaselineHash(): string {
    if (!_baselineHash) {
      _baselineHash = computeBaselineHash()
    }
    return _baselineHash
  }

  function isExternal(filePath: string | null | undefined): boolean {
    if (!filePath) return false
    if (snapshot.complete === false) return true
    return externalSet.has(filePath)
  }

  function isComplete(): boolean {
    return snapshot.complete !== false
  }

  function replaceSnapshot(next: BaselineSnapshot): void {
    snapshot = next
    externalSet = new Set([
      ...next.preExistingDirty,
      ...next.preExistingUntracked,
    ])
    _baselineHash = null
  }

  function getExternalFiles(): string[] {
    return [...externalSet].sort()
  }

  function getExternalDirtyCount(): number {
    return snapshot.preExistingDirty.length
  }

  function getExternalUntrackedCount(): number {
    return snapshot.preExistingUntracked.length
  }

  function getBranch(): string {
    return snapshot.branch
  }

  function getHead(): string {
    return snapshot.head
  }

  function toSnapshot(): BaselineSnapshot {
    return {
      branch: snapshot.branch,
      head: snapshot.head,
      preExistingDirty: [...snapshot.preExistingDirty],
      preExistingUntracked: [...snapshot.preExistingUntracked],
      capturedAt: snapshot.capturedAt,
      complete: snapshot.complete,
    }
  }

  return {
    getBranch,
    getHead,
    isExternal,
    isComplete,
    replaceSnapshot,
    getExternalFiles,
    getExternalDirtyCount,
    getExternalUntrackedCount,
    getBaselineHash,
    toSnapshot,
  }
}
