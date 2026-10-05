/**
 * tool-inventory.ts — MCP 工具清单快照门（rug pull 防线 ①）。
 *
 * 背景与目标（2026-10-04 安全报告《MCP 工具描述 rug pull》）：
 * 连接级审批（#215）的指纹是**配置身份**（command/args/cwd/envKeys/url）——
 * 「批准这条命令」；工具**清单内容**（描述/schema）不在任何审批与监控面内：
 * 重连/重启/热更新都会重拉清单，服务器可在审批之后任意换脸，用户与模型零信号。
 *
 * 本模块把「上次被接受的清单」持久化为快照（只存 name + 两个 hash，不存描述
 * 原文——缩小静态暴露面），每次连接拉到新清单后 diff：
 *
 *   - 首次 / 一致 / armed 匹配 → allow（写 accepted）
 *   - 不一致 + 交互宿主（gate） → block：由 manager 断开连接、登记待批 pending
 *     （含 diff 摘要）；用户 approve 时把「被展示的那版 hash」arm 下来，重拉
 *     精确匹配才消费放行——用户批准的是他看到的版本，批准期间二次换毒拦得住
 *     （TOCTOU；见 evaluateInventoryGate 的 armed 分支与测试用例）。
 *   - 不一致 + fail-open 宿主（无 UI，与 #215「无 UI 不拦」严格对齐）→ allow +
 *     changed 标记（manager 把变更拼进工具描述警示 = 模型可见信号 ③）；**不写
 *     accepted**——「存在未接受的变更」持续可见，直到被显式接受。
 *
 * 存储 `<rivetHome>/mcp-tool-inventory.json`（与 mcp-approvals.json 同目录、
 * 同 writeFileAtomicSync 写入口径；按配置指纹键控，永不写进仓库目录）。
 * 读失败/坏文件按「首次」处理——变更检测是增强层，不引入新的全员卡死故障模式。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { stableStringify } from '../api/stable-json.js'

/** 计算所需的最小工具形状（自足类型——不与 manager 形成运行时/类型环）。 */
export interface InventoryTool {
  name: string
  description?: string
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
}

/** 单条工具指纹：只有名字与两个 hash（不含描述原文）。 */
export interface InventoryEntry {
  name: string
  descHash: string
  schemaHash: string
}

/** 一次「已接受清单」的快照。 */
export interface InventoryRecord {
  serverId: string
  /** entries（按 name 排序）整体 hash。 */
  hash: string
  entries: InventoryEntry[]
  updatedAt: string
}

export interface InventoryDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

interface InventoryStore {
  /** fingerprint → 最近被接受的清单快照。 */
  accepted: Record<string, InventoryRecord>
  /** fingerprint → 用户已批准、待下次连接消费的清单 hash（approve 时写入）。 */
  armed?: Record<string, { hash: string; at: string }>
}

/** block 时交给 manager 登记进 pendingApprovals 的载荷（appenditive 字段）。 */
export interface InventoryPendingPayload {
  reason: 'inventory-change'
  inventoryHash: string
  inventoryDiff: InventoryDiff
  changedAt: string
}

export type InventoryVerdict =
  | { action: 'allow'; record: InventoryRecord; changed?: { diff: InventoryDiff; changedAt: string } }
  | { action: 'block'; record: InventoryRecord; diff: InventoryDiff; pending: InventoryPendingPayload }

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 计算工具清单快照（entries 按 name 排序：服务器列表顺序波动不算变更）。 */
export function computeInventory(serverId: string, tools: readonly InventoryTool[]): InventoryRecord {
  const entries: InventoryEntry[] = tools
    .map((t) => ({
      name: t.name,
      descHash: sha256(t.description ?? ''),
      schemaHash: sha256(stableStringify(t.inputSchema ?? {})),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    serverId,
    hash: sha256(stableStringify(entries)),
    entries,
    updatedAt: new Date().toISOString(),
  }
}

export function diffInventory(prev: InventoryRecord | null, next: InventoryRecord): InventoryDiff {
  const prevBy = new Map((prev?.entries ?? []).map((e) => [e.name, e]))
  const nextBy = new Map(next.entries.map((e) => [e.name, e]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, e] of nextBy) {
    const old = prevBy.get(name)
    if (!old) { added.push(name); continue }
    if (old.descHash !== e.descHash || old.schemaHash !== e.schemaHash) changed.push(name)
  }
  for (const name of prevBy.keys()) if (!nextBy.has(name)) removed.push(name)
  return { added, removed, changed }
}

// ── 存储 ───────────────────────────────────────────────────────────────────

function inventoryStorePath(): string {
  return join(rivetHome(), 'mcp-tool-inventory.json')
}

/** 读 store；缺失/坏文件按空处理（fail-open 到「首次」，见文件头）。 */
export function readInventoryStore(): InventoryStore {
  try {
    const raw = JSON.parse(readFileSync(inventoryStorePath(), 'utf-8')) as Partial<InventoryStore>
    if (raw && typeof raw === 'object') {
      return {
        accepted: raw.accepted && typeof raw.accepted === 'object' ? raw.accepted : {},
        armed: raw.armed && typeof raw.armed === 'object' ? raw.armed : undefined,
      }
    }
  } catch {
    // 缺失/坏文件按未建立快照处理
  }
  return { accepted: {} }
}

function writeInventoryStore(store: InventoryStore): void {
  const dir = rivetHome()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(inventoryStorePath(), JSON.stringify(store, null, 2) + '\n')
}

// ── 告警（fail-open 路径的可见性）──────────────────────────────────────────

let warnSink: ((msg: string) => void) | null = null
const warned = new Set<string>()

/** @internal 测试缝：替换告警输出口；null 恢复 console.error。 */
export function __setInventoryWarnSink(sink: ((msg: string) => void) | null): void {
  warnSink = sink
}

/** @internal 测试缝：清空告警去重台账。 */
export function __resetInventoryWarnings(): void {
  warned.clear()
}

function warnChangeOnce(fingerprint: string, serverId: string, hash: string, diff: InventoryDiff): void {
  const key = `${fingerprint}:${hash}`
  if (warned.has(key)) return
  warned.add(key)
  const line = `[rivet] MCP 服务器「${serverId}」工具清单变更（新增 ${diff.added.length} / 移除 ${diff.removed.length} / 修改 ${diff.changed.length}）——`
    + '当前宿主无交互审批 UI（fail-open），已放行但视为未经重新审批；变更提示已拼入该服务器工具描述。'
  if (warnSink) warnSink(line)
  else console.error(line)
}

// ── 决策与批准 ─────────────────────────────────────────────────────────────

/**
 * 清单门决策（manager 在每次 _discoverTools 之后、注册工具之前调用）。
 * 纯同步 + 单次 store 读写；并发连接由 manager 的 connectLocks 串行化。
 */
export function evaluateInventoryGate(opts: {
  fingerprint: string
  serverId: string
  tools: readonly InventoryTool[]
  /** 交互宿主（gate）：true 时不一致 → block；false（fail-open）→ 放行 + 标记。 */
  interactive: boolean
}): InventoryVerdict {
  const store = readInventoryStore()
  const record = computeInventory(opts.serverId, opts.tools)
  const prev = store.accepted[opts.fingerprint] ?? null

  if (!prev) {
    store.accepted[opts.fingerprint] = record
    writeInventoryStore(store)
    return { action: 'allow', record }
  }
  if (prev.hash === record.hash) return { action: 'allow', record }

  const armed = store.armed?.[opts.fingerprint]
  if (armed && armed.hash === record.hash) {
    store.accepted[opts.fingerprint] = record
    if (store.armed) {
      delete store.armed[opts.fingerprint]
      if (Object.keys(store.armed).length === 0) delete store.armed
    }
    writeInventoryStore(store)
    return { action: 'allow', record }
  }

  const diff = diffInventory(prev, record)
  const changedAt = new Date().toISOString()
  if (opts.interactive) {
    return {
      action: 'block',
      record,
      diff,
      pending: { reason: 'inventory-change', inventoryHash: record.hash, inventoryDiff: diff, changedAt },
    }
  }
  warnChangeOnce(opts.fingerprint, opts.serverId, record.hash, diff)
  return { action: 'allow', record, changed: { diff, changedAt } }
}

/** 记录「用户已批准该清单 hash」——approve 时由 manager 调用；下次连接精确匹配消费。 */
export function armInventoryApproval(fingerprint: string, hash: string): void {
  const store = readInventoryStore()
  store.armed = store.armed ?? {}
  store.armed[fingerprint] = { hash, at: new Date().toISOString() }
  writeInventoryStore(store)
}

// ── 文案（③ 模型可见信号）──────────────────────────────────────────────────

/** 「清单变更」一行文案——由 manager 传入 wrapper 的 inventoryNotice（拼进描述警示块）。 */
export function formatInventoryNotice(diff: InventoryDiff, changedAt: string): string {
  const d = new Date(changedAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const names = [...diff.changed, ...diff.added, ...diff.removed]
  const detail = names.length > 0
    ? `：${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}`
    : ''
  return `本服务器工具清单于 ${time} 检测到变更（新增 ${diff.added.length} / 移除 ${diff.removed.length} / 修改 ${diff.changed.length}${detail}），尚未经重新审批`
}
