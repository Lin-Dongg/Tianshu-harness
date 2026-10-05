/**
 * @deprecated 经络图（src/repo/meridian-*.ts）已提供持久化 SQLite 反向 BFS 影响分析。
 * 本模块保留仅供 fallback（tool-pipeline 无 meridianIndexer 时），计划在确认全量迁移后移除。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, resolve, dirname, isAbsolute, extname } from 'path'

export interface ImportGraph {
  forward: Map<string, Set<string>>
  reverse: Map<string, Set<string>>
}

// 相对说明符的全部静态/动态引入形态：
//   import x from './a' · import type { T } from '../b' · import './side-effect'
//   export { x } from './c' · export * from '../d' · require('./e') · import('./f')
// 旧正则两处缺陷（静默丢边 → impact hint 漏报）：
//   1) 第二支写成 `\.\\.`（字面「.\」+任一字符），本意是 `../`——所有跨目录的父级引入恒不命中；
//   2) `.*?` 不跨行，多行具名导入 `import {\n a,\n} from` 与 `export … from` 重导出均漏。
// 花括号段只消费标识符/空白/逗号/`*`，不跨引号——保证侧效引入不会吞掉下一行的说明符。
const IMPORT_RE = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s*)?|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g
/** ESM TS 惯例：源码写 './x.js'，磁盘上是 x.ts——解析时按此映射补候选。 */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}
const MAX_FILES = 1000

function resolveImport(fromFile: string, importPath: string, cwd: string): string | null {
  const baseDir = dirname(fromFile)
  const absPath = resolve(cwd, baseDir, importPath)
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) {
    const candidate = absPath + ext
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  const jsExt = extname(absPath)
  const tsExts = JS_TO_TS[jsExt]
  if (tsExts) {
    const stem = absPath.slice(0, -jsExt.length)
    for (const ext of tsExts) {
      const candidate = stem + ext
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  // index 候选必须用 join 而非字符串拼 '/index.ts'：Windows 上拼出来是混合分隔符
  // （…\mod/index.ts），与 collectTsFiles 收集的原生路径（…\mod\index.ts）字符串不等，
  // forward.has(resolved) 落空 → index 形式的重导出在 Windows 上恒丢边。
  for (const idx of ['index.ts', 'index.tsx', 'index.js']) {
    const candidate = join(absPath, idx)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function collectTsFiles(cwd: string): string[] {
  const files: string[] = []
  function walk(dir: string): void {
    if (files.length >= MAX_FILES) return
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Import graph is a best-effort impact-hint feature (deprecated, superseded
      // by meridian-*.ts). A permission error on a subdir must never produce
      // tool errors or kill the run — silently skip the unreadable directory.
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(full)
      }
    }
  }
  walk(cwd)
  return files
}

export function buildImportGraph(cwd: string, maxFiles?: number): ImportGraph | null {
  const files = collectTsFiles(cwd)
  if (maxFiles !== undefined && files.length > maxFiles) return null
  if (files.length > MAX_FILES) return null

  const forward = new Map<string, Set<string>>()
  const reverse = new Map<string, Set<string>>()

  for (const file of files) {
    forward.set(file, new Set())
  }

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scanImportsInto(file, content, cwd, forward, reverse)
  }

  return { forward, reverse }
}

/** 单文件的 import 解析进图（同步/异步构建与 invalidateFile 共用）。 */
function scanImportsInto(
  file: string,
  content: string,
  cwd: string,
  forward: Map<string, Set<string>>,
  reverse: Map<string, Set<string>>,
): void {
  const imports = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags)
  while ((match = re.exec(content)) !== null) {
    const importPath = match[1]!
    const resolved = resolveImport(file, importPath, cwd)
    if (resolved && forward.has(resolved)) {
      imports.add(resolved)
    }
  }
  forward.set(file, imports)
  for (const imp of imports) {
    if (!reverse.has(imp)) reverse.set(imp, new Set())
    reverse.get(imp)!.add(file)
  }
}

// ── 异步分片构建（冷库回落后台化，2026-09-12） ──────────────────────────────

/** 单批文件数——批间 setImmediate 让出事件循环，构建期不再整段冻结。 */
const ASYNC_BATCH = 40
const yieldLoop = () => new Promise<void>((r) => setImmediate(r))

async function collectTsFilesAsync(cwd: string, requireComplete = false): Promise<string[]> {
  const { readdir } = await import('fs/promises')
  const files: string[] = []
  const pending = [cwd]
  while (pending.length > 0 && (!requireComplete || files.length <= MAX_FILES) && files.length < MAX_FILES + (requireComplete ? 1 : 0)) {
    const dir = pending.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      if (requireComplete) throw new Error('unreadable import graph directory')
      continue // 与同步版同语义：不可读子目录静默跳过（best-effort 特性）
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES + (requireComplete ? 1 : 0)) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(full)
      else if ((requireComplete ? /\.(?:[cm]?[jt]sx?|py|go)$/ : /\.(ts|tsx)$/).test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full)
    }
    await yieldLoop()
  }
  return files
}

/**
 * 与 buildImportGraph 同语义的异步分片变体——目录遍历与文件读取分批让出
 * 事件循环。**冷库回落的后台构建专用**：同步版在大仓整段冻结事件循环数秒，
 * abort/中断落进 stall 尖峰即 orphan tool_use → reliability minimal 冻结链
 * （2026-08 起桌面复发事故，tool-pipeline 冷库回落路径）。只可在
 * fire-and-forget 里调用，不要 await 在写工具关键路径上。
 */
export async function buildImportGraphAsync(cwd: string, options?: { requireComplete?: boolean }): Promise<ImportGraph | null> {
  const { readFile } = await import('fs/promises')
  const files = await collectTsFilesAsync(cwd, options?.requireComplete)
  if (files.length > MAX_FILES) return null

  const forward = new Map<string, Set<string>>()
  const reverse = new Map<string, Set<string>>()
  for (const file of files) forward.set(file, new Set())

  for (let i = 0; i < files.length; i += ASYNC_BATCH) {
    const batch = files.slice(i, i + ASYNC_BATCH)
    const contents = await Promise.all(batch.map(async (f) => {
      try { return await readFile(f, 'utf8') } catch { if (options?.requireComplete) throw new Error('unreadable import graph file'); return null }
    }))
    for (let j = 0; j < batch.length; j++) {
      const content = contents[j]
      if (content == null) continue
      scanImportsInto(batch[j]!, content, cwd, forward, reverse)
    }
    await yieldLoop()
  }
  return { forward, reverse }
}

export function getReverseDeps(graph: ImportGraph, file: string, cwd?: string): Set<string> {
  // isAbsolute 而非 startsWith('/')：Windows 绝对路径是 D:\… / D:/…，只查 '/' 会把它
  // 当成相对路径——不传 cwd 时 absPath 退化成 '' 并返回空集，反向依赖在 Windows 上静默失明。
  const absPath = isAbsolute(file) ? file : cwd ? resolve(cwd, file) : ''
  return absPath ? (graph.reverse.get(absPath) ?? new Set()) : new Set()
}

export function invalidateFile(graph: ImportGraph, cwd: string, file: string): ImportGraph {
  const absFile = isAbsolute(file) ? file : resolve(cwd, file)

  // Remove old forward edges for this file
  const oldImports = graph.forward.get(absFile) ?? new Set()
  for (const imp of oldImports) {
    const rev = graph.reverse.get(imp)
    if (rev) rev.delete(absFile)
  }

  // Re-scan this file
  let content: string
  try {
    content = readFileSync(absFile, 'utf8')
  } catch {
    graph.forward.delete(absFile)
    return graph
  }

  const newImports = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags)
  while ((match = re.exec(content)) !== null) {
    const importPath = match[1]!
    const resolved = resolveImport(absFile, importPath, cwd)
    if (resolved && graph.forward.has(resolved)) {
      newImports.add(resolved)
    }
  }

  graph.forward.set(absFile, newImports)
  for (const imp of newImports) {
    if (!graph.reverse.has(imp)) graph.reverse.set(imp, new Set())
    graph.reverse.get(imp)!.add(absFile)
  }

  return graph
}
