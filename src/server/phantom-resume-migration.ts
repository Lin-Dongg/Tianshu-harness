/**
 * P0-4 —「假中断标记」一次性迁移（phantom resume migration）。
 *
 * 背景：桌面端 sidecar 共用会话库时，另一个 sidecar 启动会在 rehydrate() 里把
 * 仍在运行的会话误判为「崩溃恢复」（见 session-manager.ts 的 wasRunning 分支）：
 * 它按 `durableHighWater + CRASH_RECOVERY_SEQ_GAP` 分配序号，写下一段**假的中断
 * 标记**（status{reason:'sidecar-restart'} / resume_offer / approval_resolved），
 * 然后真实 run 继续用自己更小的序号写输出。前端的 `ev.seq <= state.lastSeq`
 * 守卫（desktop/src/state/event-reducer.ts applyEventInner 开头）会把这之后
 * 所有真实事件当重复丢掉——用户看到「会话被切断、后面全没了」。
 *
 * 真实数据只在磁盘上留下这个形状（只读核验，2026-10-04）：
 *   ~/.rivet/desktop/sessions/2026100340b5a1049972/events.jsonl
 *     第 30608 行  {"seq":30608,...,"type":"delegation",...}                ← 真实 run 落盘
 *     第 30609 行  {"seq":130609,...,"type":"status","data":{"status":"aborted","reason":"sidecar-restart"}}
 *     第 30610 行  {"seq":130610,...,"type":"resume_offer",...}              ← 假标记（30608 + 100000 + 1）
 *     第 30611 行  {"seq":30609,...,"type":"delegation",...}                ← 真实 run 继续，序号更小
 *   即：`跳高段（只含标记） → 紧跟一个序号更小的事件`。
 *
 * 处置规则（宁可少删——误删真实事件不可逆）：
 *   1. 从某条事件起序号突然跳高（比前一条 parsed 事件大 PHANTOM_MIN_SEQ_JUMP 以上）；
 *   2. 从跳高点起、序号仍 ≥ 跳高点的**连续标记事件**只含 status(resume 标记) /
 *      resume_offer / approval_resolved 三类——遇到非标记事件即视为「这段夹带了别的
 *      内容」，判定失败；
 *   3. 这段标记之后紧跟一个序号更小的事件（回到真实 run 的序号带）。
 *   三条同时满足才删这段；任一条不满足 → 不动该段（记入报告 skipped）。
 *   步进只覆盖被识别的这一小段，绝不整段吞掉高位平台——真实受损日志里高位平台
 *   内部还嵌着别的假标记段（如 20261001f92959da0d34），一口吞会漏修。
 *   关键判别：**真实崩溃恢复**（进程真的死了、新实例接手）里，跳高之后的事件序号
 *   也是更高的（标记段一直延续到文件末尾，没有回落），不会被误删。
 *
 * 修复动作：删除假标记行 → 原始行写进 removedBackupPath（JSONL，含 sessionId/index/
 * 原始行，可逐字还原）→ events.jsonl 走 tmp+rename 原子重写 → 删除派生缓存
 * events.index.jsonl / events.summary.json / events.summary-blocks/。派生缓存删除后
 * 由 session-persistence.ts 的 rebuildAndSlice（约 L1022）自愈重建。
 *
 * 只跑一次：doneMarkerPath 存在则直接返回空报告。逐会话处理、文件之间让出事件循环。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'

/** 迁移版本号——同时作为标记录 / 备份文件的基名。 */
export const PHANTOM_RESUME_MIGRATION_VERSION = 'phantom-resume-v1'

/**
 * 判定「序号突然跳高」的最小幅度。真实事件序号逐条 +1（delta 合并仍是单条 seq），
 * 唯一会制造大跳的是崩溃恢复的 CRASH_RECOVERY_SEQ_GAP（100_000，见
 * session-manager.ts）。取 1000 作门槛：远高于正常增量，又远低于该 gap，
 * 对跨版本 gap 变化也留了余量。真正排除误删靠的是「只含标记 + 段后回落到更小序号」。
 */
export const PHANTOM_MIN_SEQ_JUMP = 1_000

const EVENTS_FILE = 'events.jsonl'
/** 直接删除、交给 rebuildAndSlice 自愈重建的派生缓存。 */
const DERIVED_CACHE_FILES = ['events.index.jsonl', 'events.summary.json'] as const
const DERIVED_CACHE_DIRS = ['events.summary-blocks'] as const

export interface PhantomResumeMigrationOptions {
  /** 桌面端会话根目录（desktopSessionsDir()）。 */
  sessionsDir: string
  /** 被删行的备份 JSONL 路径。默认 `<sessionsDir 的父目录>/.migrations/phantom-resume-v1.removed.jsonl`。 */
  removedBackupPath?: string
  /** 「已跑过」标记文件。存在即直接返回空报告。默认同目录 `phantom-resume-v1.done`。 */
  doneMarkerPath?: string
  /** 会话是否仍在运行——运行中的会话必须跳过（磁盘可能正被追加）。默认恒 false。 */
  isSessionRunning?: (id: string) => boolean
  /** 诊断日志行回调。 */
  log?: (line: string) => void
}

export interface PhantomResumeMigrationReport {
  /** 检视过的会话目录数（含 events.jsonl 者）。 */
  scanned: number
  /** 实际删除了 ≥1 段假标记的会话 id。 */
  repaired: string[]
  /** 检视了但有意不改动的会话（及其原因）。 */
  skipped: Array<{ id: string; reason: string }>
  /** 处理时报错的会话。 */
  failed: Array<{ id: string; reason: string }>
}

/** 一行 events.jsonl 的解析结果。ok=false 表示空行 / 坏行——不参与序号推进。 */
export interface ParsedEventLine {
  raw: string
  ok: boolean
  seq: number | null
  type?: string
  data?: Record<string, unknown>
}

/** 一段待删区间，半开 [start, end)（原始行下标）。 */
export interface PhantomSegment {
  start: number
  end: number
}

function parseEventLine(raw: string): ParsedEventLine {
  const trimmed = raw.trim()
  if (!trimmed) return { raw, ok: false, seq: null }
  try {
    const obj = JSON.parse(trimmed) as { seq?: unknown; type?: unknown; data?: unknown }
    if (typeof obj.seq !== 'number' || !Number.isFinite(obj.seq)) return { raw, ok: false, seq: null }
    return {
      raw,
      ok: true,
      seq: obj.seq,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      data: obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined,
    }
  } catch {
    return { raw, ok: false, seq: null }
  }
}

/**
 * 该行是否属于「续跑/中断标记」三类。
 *
 * resume_offer / approval_resolved 直接命中。status 有两种真实形态：
 *   - `{status:'aborted', reason:'sidecar-restart'}`——rehydrate 写的规范标记；
 *   - `{status:'aborted'}`（无 reason）——同一段假会话随后走 abort() 落盘
 *     （session-manager.ts `this.append(s, 'status', { status: 'aborted' })`），
 *     序号接在假标记之后（真实样本 202610013601ef8517d5 第 15238 行 seq=108544）。
 * 两者都在同一次误判里产生，必须一并回收。`status:'running'` 之类不算——避免把
 * 正常状态迁移误认成标记（真正兜底的是「跳高段 + 段后回落」两条硬约束）。
 */
export function isResumeMarker(line: ParsedEventLine): boolean {
  if (!line.ok) return false
  switch (line.type) {
    case 'resume_offer':
    case 'approval_resolved':
      return true
    case 'status': {
      const d = line.data ?? {}
      return d.reason === 'sidecar-restart' || d.status === 'aborted'
    }
    default:
      return false
  }
}

/**
 * 在一段已解析的日志里找出「假中断标记段」。纯函数，供测试直接驱动。
 *
 * @returns phantom：确定要删的区间；declined：见过跳高段但依规不删的原因（去重后逐条）。
 */
export function findPhantomResumeSegments(lines: ParsedEventLine[]): {
  phantom: PhantomSegment[]
  declined: string[]
} {
  // 每条事件之前「最近一条成功解析」的序号——坏行不推进序号，也不重置比较基准。
  const prevSeq: Array<number | null> = []
  let last: number | null = null
  for (const line of lines) {
    prevSeq.push(last)
    if (line.ok && line.seq !== null) last = line.seq
  }

  const phantom: PhantomSegment[] = []
  const declined = new Set<string>()
  let i = 0
  while (i < lines.length) {
    const cur = lines[i]!
    const before = prevSeq[i]!
    if (cur.ok && cur.seq !== null && before !== null && cur.seq - before > PHANTOM_MIN_SEQ_JUMP) {
      const elevated = cur.seq
      // 「跳号段」= 从跳高点起的**连续**标记事件（序号 ≥ 跳高点）。一旦遇到非标记
      // 事件即停（说明这段夹带了别的内容），遇到序号回落到跳高点之下也停（真实
      // run 的序号带）。这样步进只覆盖这段本身，不会一口吞掉整条高位平台——
      // 真实受损日志里高位平台内部还嵌着别的假标记段（如 20261001f92959da0d34）。
      let j = i
      let markerOnly = true
      while (j < lines.length) {
        const band = lines[j]!
        if (!band.ok || band.seq === null) {
          // 空行（含文件尾换行产生的空串）不是事件，忽略；非空坏行无法证明它属于
          // 标记段，保守判为「有其他内容」。
          if (band.raw.trim() !== '') markerOnly = false
          j++
          continue
        }
        if (band.seq < elevated) break
        if (!isResumeMarker(band)) {
          markerOnly = false
          break
        }
        j++
      }
      const next = j < lines.length ? lines[j]! : undefined
      const backDown = next !== undefined && next.ok && next.seq !== null && next.seq < elevated

      if (backDown && markerOnly && j > i) {
        phantom.push({ start: i, end: j })
        i = j // 删掉的这一段无需再作为跳座检查
        continue
      }
      // 依规不删：只在 i 前进一格继续找平台内部的其它段，不跳过整个高位平台。
      declined.add(
        !markerOnly
          ? 'jump-segment-not-marker-only'
          : 'marker-segment-without-backdown',
      )
      i++
      continue
    }
    i++
  }
  return { phantom, declined: [...declined] }
}

/**
 * 对全部会话执行一次假中断标记迁移。由拿到锁的 sidecar 启动后在后台异步执行一次。
 *
 * 只读不写任何未受影响会话；对每个受损会话：备份被删行 → 原子重写 events.jsonl →
 * 删除派生缓存。逐会话之间 `await setImmediate` 让出事件循环，避免长扫描饿死其它请求。
 */
export async function runPhantomResumeMigration(
  opts: PhantomResumeMigrationOptions,
): Promise<PhantomResumeMigrationReport> {
  const log = opts.log ?? ((): void => {})
  const isRunning = opts.isSessionRunning ?? ((): boolean => false)

  const desktopRoot = dirname(resolve(opts.sessionsDir))
  const migrationsDir = join(desktopRoot, '.migrations')
  const removedBackupPath = opts.removedBackupPath ?? join(migrationsDir, `${PHANTOM_RESUME_MIGRATION_VERSION}.removed.jsonl`)
  const doneMarkerPath = opts.doneMarkerPath ?? join(migrationsDir, `${PHANTOM_RESUME_MIGRATION_VERSION}.done`)

  const report: PhantomResumeMigrationReport = { scanned: 0, repaired: [], skipped: [], failed: [] }

  if (existsSync(doneMarkerPath)) {
    log(`[phantom-resume] done marker present (${doneMarkerPath}) — skip`)
    return report
  }

  let ids: string[]
  try {
    ids = readdirSync(opts.sessionsDir).filter((id) => {
      try {
        return statSync(join(opts.sessionsDir, id)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    log(`[phantom-resume] sessions dir unreadable (${opts.sessionsDir}) — nothing to scan`)
    return report
  }

  for (const id of ids) {
    const dir = join(opts.sessionsDir, id)
    const eventsFile = join(dir, EVENTS_FILE)
    if (!existsSync(eventsFile)) continue
    report.scanned++

    if (isRunning(id)) {
      report.skipped.push({ id, reason: 'session-running' })
      continue
    }

    try {
      const lines = readFileSync(eventsFile, 'utf8').split('\n')
      const parsed = lines.map(parseEventLine)
      const { phantom, declined } = findPhantomResumeSegments(parsed)
      for (const reason of declined) report.skipped.push({ id, reason })
      if (phantom.length === 0) continue

      const drop = new Set<number>()
      for (const seg of phantom) for (let k = seg.start; k < seg.end; k++) drop.add(k)
      const indices = [...drop].sort((a, b) => a - b)

      // 1) 先落备份（含原始行下标，可逐字还原）——备份失败即中止，不动原文件。
      const backupLines = indices.map((k) => JSON.stringify({ sessionId: id, index: k, line: lines[k] }))
      mkdirSync(dirname(removedBackupPath), { recursive: true })
      appendFileSync(removedBackupPath, backupLines.join('\n') + '\n', 'utf8')

      // 2) 原子重写：写临时文件再 rename，崩溃/中断下原文件要么全旧要么全新。
      const kept = lines.filter((_, k) => !drop.has(k))
      const tmp = `${eventsFile}.${PHANTOM_RESUME_MIGRATION_VERSION}.tmp`
      writeFileSync(tmp, kept.join('\n'), 'utf8')
      renameSync(tmp, eventsFile)

      // 3) 派生缓存删除（rebuildAndSlice 自愈重建）。
      for (const f of DERIVED_CACHE_FILES) rmSync(join(dir, f), { force: true })
      for (const d of DERIVED_CACHE_DIRS) rmSync(join(dir, d), { recursive: true, force: true })

      report.repaired.push(id)
      log(`[phantom-resume] repaired ${id}: removed ${indices.length} phantom line(s) in ${phantom.length} segment(s)`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      report.failed.push({ id, reason })
      log(`[phantom-resume] failed ${id}: ${reason}`)
    }

    // 逐会话之间让出事件循环——大日志的读/写/删不该独占主线程。
    await yieldToLoop()
  }

  // 只有全部成功才落「已跑过」标记：任一会话失败则下次启动重试（迁移是幂等的）。
  if (report.failed.length === 0) {
    try {
      mkdirSync(dirname(doneMarkerPath), { recursive: true })
      writeFileSync(
        doneMarkerPath,
        JSON.stringify({ version: PHANTOM_RESUME_MIGRATION_VERSION, ts: Date.now(), scanned: report.scanned, repaired: report.repaired }) + '\n',
        'utf8',
      )
    } catch (err) {
      log(`[phantom-resume] could not write done marker: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log(`[phantom-resume] ${report.failed.length} session(s) failed — done marker withheld for retry`)
  }

  return report
}
