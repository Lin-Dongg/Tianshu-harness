import { currentWorkspaceRoots } from './workspace-context.js'
import { execFile } from 'child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
import { existsSync } from 'fs'
import { lstat, readdir, realpath, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { getResolvedEnv } from './resolved-env.js'
import type { Dirent } from 'node:fs'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { relativePosix } from '../path-format.js'
import { truncateContent } from './truncation.js'
import { GitignoreFilter } from './gitignore.js'
import { validatePathSafe } from './path-validate.js'
import { searchReadableFilesWithRipgrep } from './grep-ripgrep.js'
import { summarizeGrepResult } from '../artifact/summarize.js'
import type { ArtifactStore } from '../artifact/store.js'
import { computeModelReadCap, type ModelReadCap } from './model-read-cap.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { hashLine } from './hash-edit.js'
import { registerGrepFileAccess } from './read-file.js'
import { isRestrictedPath } from '../platform/restricted-paths.js'
import { isScanExcludedDir } from './scan-excludes.js'
import { scanForMatches, scanForRange, DEFAULT_MAX_LINE_CHARS, type ScanBudget, type MatchLine } from './bounded-scan.js'
import { cpuPool } from '../workers/cpu-pool.js'
import type { GrepScanRawResult } from '../workers/grep-scan-task.js'

const MAX_RESULTS_DEFAULT = 100
const MIN_RESULTS = 1
// Ceiling is deliberately high: memory is bounded by the scanner's retention
// budget (bounded-scan), NOT by max_results, so a large cap is harmless. The
// rg hit-cap path (grep.test.ts) legitimately asks for 100_000.
const MAX_RESULTS = 1_000_000
const MAX_CONTEXT_LINES = 20
const ANCHOR_LINE_LIMIT = 10
const TIMEOUT_MS = 30_000

/** Safe label for debug logs — pattern may be missing if tool JSON is malformed. */
function grepPatternLabel(pattern: unknown): string {
  if (typeof pattern === 'string') return pattern.slice(0, 40)
  if (pattern == null) return '(missing)'
  return String(pattern).slice(0, 40)
}

function parseGrepPattern(input: Record<string, unknown>): string | null {
  const raw = input.pattern
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 空结果 sentinel——search-pod-hook 靠 includes(此串) 识别「可信排除」，
 *  改文案必须与 hook 同步（用常量共享，禁止两边各自手抄）。 */
export const GREP_EMPTY_RESULT = '未找到匹配。'

export const GREP_TOOL: Tool = {
  definition: {
    name: 'grep',
    description: `用正则或字面量模式搜索文件内容。

### 用法
- 用 grep 在源码中查找函数、类、模式或关键字
- 优先用本工具而不是 bash grep/rg——更快，且遵守 .gitignore
- 结果按文件分组并带行号
- pattern 可以是正则（默认）或字面量字符串
- 不知道确切字符串或符号、需要按概念搜索时，改用 semantic_search

### 示例
Good: grep(pattern="function handleSubmit", path="src/")
Good: grep(pattern="API_KEY", path=".", glob="*.{ts,tsx}")
Good: grep(pattern="class Foo", path="src/", context_lines=3)
Bad: grep(pattern="x") (too broad — will match too many lines)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则或字面量模式' },
        path: { type: 'string', description: '要搜索的目录或文件（默认：cwd）' },
        glob: { type: 'string', description: '文件过滤，如 "*.ts" 或 "*.{ts,tsx}"' },
        max_results: { type: 'integer', description: '最大匹配行数（默认：100）' },
        literal: { type: 'boolean', description: '把 pattern 按字面量处理，不当正则（默认：false）' },
        context_lines: { type: 'integer', description: '每个匹配前后附带的上下文行数（默认：0）。设 2-3 可直接看到周边代码，省去单独的 read_file。' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const roots = currentWorkspaceRoots(params.cwd)
    if (params.input.path === undefined && roots.length > 1) {
      const results: string[] = []
      for (const root of roots) {
        const result = await GREP_TOOL.execute({ ...params, input: { ...params.input, path: root, max_results: Math.max(1, Math.floor(Number(params.input.max_results ?? MAX_RESULTS_DEFAULT) / roots.length)) } })
        if (result.isError) return result
        results.push(`[Folder: ${root}]\n${result.content}`)
      }
      return { content: results.join('\n\n') }
    }
    const pattern = parseGrepPattern(params.input)
    if (pattern === null) {
      const keys = Object.keys(params.input).sort()
      const keySummary = keys.length > 0 ? keys.join(', ') : '(无)'
      const patternType = typeof params.input.pattern
      // Foreign keys (file_path, section, command, ...) are the fingerprint of
      // streaming argument pollution: a parallel tool_call's args got grafted
      // onto this grep call. Flag it so the root cause is visible at the tool
      // layer instead of a generic "pattern is required".
      const knownKeys = new Set(['pattern', 'path', 'glob', 'max_results', 'literal', 'context_lines'])
      const foreignKeys = keys.filter(k => !knownKeys.has(k))
      const pollutionHint = foreignKeys.length > 0
        ? ` Input 含有无关键（${foreignKeys.join(', ')}）——可能是流式 tool_call 参数污染，而非格式错误的 grep 调用。`
        : ''
      return {
        content: `错误：需要提供 pattern（非空字符串）。收到的 input keys：${keySummary}。pattern 类型：${patternType}。` +
          (keys.length === 0 ? ' Input 为空——参数可能在流式传输期间解析失败。' : '') +
          pollutionHint,
        isError: true,
      }
    }
    const searchPath = (params.input.path as string) ?? '.'
    const glob = params.input.glob as string | undefined
    const literal = (params.input.literal as boolean) ?? false

    // Range-validate the bounded knobs instead of silently coercing: a model
    // asking for max_results=0 or context_lines=9999 must be told, not handed a
    // different query than it wrote (P0 §3.2).
    const maxResults = params.input.max_results === undefined
      ? MAX_RESULTS_DEFAULT
      : Number(params.input.max_results)
    if (!Number.isInteger(maxResults) || maxResults < MIN_RESULTS || maxResults > MAX_RESULTS) {
      return {
        content: `错误：max_results 必须是 ${MIN_RESULTS}-${MAX_RESULTS} 之间的整数（收到 ${JSON.stringify(params.input.max_results)}）。`,
        isError: true,
      }
    }

    const contextLines = params.input.context_lines === undefined
      ? 0
      : Number(params.input.context_lines)
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > MAX_CONTEXT_LINES) {
      return {
        content: `错误：context_lines 必须是 0-${MAX_CONTEXT_LINES} 之间的整数（收到 ${JSON.stringify(params.input.context_lines)}）。`,
        isError: true,
      }
    }
    const modelCap = params.readCapOverride ?? computeModelReadCap({
      contextWindow: params.contextWindow,
      providerProfile: params.providerProfile,
    })

    const validated = validatePathSafe(params.cwd, searchPath)
    if (!validated.ok) {
      return { content: `错误：${validated.error}`, isError: true }
    }
    const absPath = validated.path

    const artifactThreshold = getToolArtifactThreshold('grep', params.contextWindow)

    // Try ripgrep first, fall back to native search
    const rgResult = await tryRipgrep(pattern, absPath, searchPath, glob, maxResults, params.cwd, literal, contextLines, modelCap, params.artifactStore, artifactThreshold, params.abortSignal, params.sessionId)
    if (rgResult !== null) return rgResult

    if (params.abortSignal?.aborted) return { content: 'grep 已取消。', isError: true }

    // Native fallback
    const regex = buildRegex(pattern, literal)
    if (!regex) {
      return { content: `错误：无效的模式：${pattern}`, isError: true, errorKind: 'syntax_error' }
    }

    try {
      const { results, incompleteReason } = await nativeSearch(
        absPath, { source: pattern, literal }, glob, maxResults, params.cwd, contextLines,
        { signal: params.abortSignal, deadlineAt: Date.now() + TIMEOUT_MS },
      )
      // A partial result that reads like a complete one is worse than no result:
      // "no matches" would be taken as proof the string is absent. Any early end
      // (deadline / over-long line / abort) must be stated, and must NOT be
      // downgraded to GREP_EMPTY_RESULT.
      const INCOMPLETE_NOTE = incompleteReason
        ? `[grep] 回退搜索不完整（${incompleteReason}）：以下结果不覆盖全部文件——缩小 path 或改用更具体的 glob 重试。\n`
        : ''
      if (results.length === 0) {
        return { content: `[grep] 未找到 ripgrep (rg) 或其执行失败；已使用慢速回退。\n${INCOMPLETE_NOTE}${incompleteReason ? '' : GREP_EMPTY_RESULT}` }
      }
      const FALLBACK_PREFIX = '[grep] 未找到 ripgrep (rg) 或其执行失败；已使用慢速回退。\n' + INCOMPLETE_NOTE
      const text = results.length > maxResults
        ? FALLBACK_PREFIX + results.slice(0, maxResults).join('\n') + '\n...（已截断）'
        : FALLBACK_PREFIX + results.join('\n')
      let hintedText = appendLogRangeHints(text, searchPath)
      hintedText = await appendHashEditHints(hintedText, absPath, params.cwd, params.sessionId)
      await registerGrepFilesFromOutput(hintedText, params.cwd, params.sessionId)

      if (params.artifactStore) {
        if (hintedText.length < artifactThreshold) {
          debugLog(`[artifact-skip] tool=grep pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
          return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
        }
        debugLog(`[artifact-wrap] tool=grep pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
        const { summary, sections } = summarizeGrepResult(hintedText, pattern)
        const artifactId = await params.artifactStore.save({
          tool: 'grep',
          target: searchPath,
          rawContent: hintedText,
          summary,
          sections,
        })
        const truncated = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
        return {
          content: `${truncated}\n\n${summary}\n使用 read_section(artifactId="${artifactId}", section="L1-L500") 获取完整匹配列表。\n[artifact:${artifactId}]`,
        }
      }

      return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `错误：${message}`, isError: true }
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

function buildRegex(pattern: string, literal: boolean): RegExp | null {
  try {
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
    return new RegExp(source)
  } catch {
    return null
  }
}

function isLogLikeFilePath(path: string): boolean {
  return /\.(?:log|jsonl|ndjson|out|err|trace)(?:\.\d+)?$/i.test(path)
}

function appendLogRangeHints(content: string, searchPath: string): string {
  if (!isLogLikeFilePath(searchPath)) return content
  const hints: string[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/:(\d+):/) ?? line.match(/^(\d+):/)
    if (!match?.[1]) continue
    const offset = Math.max(1, Number(match[1]) - 20)
    hints.push(`- read_file(file_path="${searchPath}", offset=${offset}, limit<=80)`)
    if (hints.length >= 5) break
  }
  if (hints.length === 0) return content
  return `${content}\n\n建议的下一步读取：\n${hints.join('\n')}`
}

/**
 * For single-file grep results, append hash_edit anchor hints so the model
 * can edit without a full read_file call: grep → hash_edit directly.
 *
 * Reads the file once, extracts hashes for matched line numbers, appends them.
 */
async function appendHashEditHints(content: string, absPath: string, cwd: string, sessionId?: string): Promise<string> {
  // Only add hints for single-file results (not directory-wide greps)
  let fileStat
  try {
    fileStat = await stat(absPath)
  } catch { return content }
  if (!fileStat.isFile()) return content

  registerGrepFileAccess(absPath, fileStat.mtimeMs, sessionId)

  const lineNumbers: number[] = []
  for (const line of content.split('\n')) {
    // rg output format: "42: line content" or ">  42│ content" (context mode)
    const m = line.match(/^>?\s*(\d+)[│:|]/) ?? line.match(/:(\d+):/)
    if (m?.[1]) {
      const num = parseInt(m[1], 10)
      if (num > 0 && !lineNumbers.includes(num)) lineNumbers.push(num)
    }
    if (lineNumbers.length >= ANCHOR_LINE_LIMIT) break
  }
  if (lineNumbers.length === 0) return content

  // Bounded re-scan — NEVER a whole-file read. Walk only [min..max] of the hit
  // line numbers and keep just the wanted originals; peak memory is O(1) in the
  // file's line count, so a huge file whose match is on line 1 no longer OOMs
  // here. (hashLine strips a trailing \r itself, so the scanner's CRLF handling
  // produces the same hash the model's hash_edit will compute.)
  let anchorLines: Map<number, string>
  try {
    anchorLines = await collectAnchorLines(absPath, lineNumbers, { deadlineMs: TIMEOUT_MS })
  } catch { return content }

  // Anchors are only useful if the file did not change while we scanned;
  // otherwise the emitted hash is stale and the model's hash_edit would fail.
  try {
    const after = await stat(absPath)
    if (after.mtimeMs !== fileStat.mtimeMs || after.size !== fileStat.size) return content
  } catch { return content }

  const hints: string[] = []
  for (const num of lineNumbers) {
    const original = anchorLines.get(num)
    if (original !== undefined) hints.push(`  L${num}:${hashLine(original)}`)
  }
  if (hints.length === 0) return content

  const relPath = relativePosix(cwd, absPath)
  return `${content}\n\nhash_edit 锚点（${relPath}）：\n${hints.join('\n')}`
}

/**
 * Resolve the original text of a handful of line numbers via a bounded forward
 * scan — never a whole-file read. Only the requested lines are retained, so
 * peak memory is O(1) in the file's line count.
 */
async function collectAnchorLines(
  absPath: string,
  lineNumbers: number[],
  budget?: ScanBudget,
): Promise<Map<number, string>> {
  const wanted = [...new Set(lineNumbers.filter(n => Number.isInteger(n) && n > 0))]
    .sort((a, b) => a - b)
    .slice(0, ANCHOR_LINE_LIMIT)
  const out = new Map<number, string>()
  if (wanted.length === 0) return out
  const min = wanted[0]!
  const max = wanted[wanted.length - 1]!
  const wantedSet = new Set(wanted)
  const res = await scanForRange(absPath, min, max - min + 1, budget)
  for (const line of res.lines) {
    // Bind strictly by the scanner's real line number: an over-long line in the
    // span is skipped rather than returned, so positional mapping (min + i)
    // would shift every later anchor onto the wrong line — a wrong hash_edit
    // anchor edits the wrong line. A clipped (truncated) line is not hashed.
    if (wantedSet.has(line.lineNumber) && !line.truncated) out.set(line.lineNumber, line.text)
  }
  return out
}

/**
 * Register file access from grep results for directory-wide greps.
 * Parses rg output lines to extract file paths, stats each, and registers
 * them in fileReadHistory so hash_edit can be used directly.
 */
async function registerGrepFilesFromOutput(content: string, cwd: string, sessionId?: string): Promise<void> {
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    // rg --no-heading format: "relative/path:linenum: content"
    const m = line.match(/^(.+?):(\d+):/)
    if (!m?.[1]) continue
    const relPath = m[1]
    if (seen.has(relPath)) continue
    seen.add(relPath)
    try {
      const absFilePath = resolve(cwd, relPath)
      const s = await stat(absFilePath)
      if (s.isFile()) {
        registerGrepFileAccess(absFilePath, s.mtimeMs, sessionId)
      }
    } catch { /* skip unresolvable paths */ }
    if (seen.size >= 20) break
  }
}

/**
 * 解析 rg 二进制路径，带架构探活。
 *
 * 优先级：RIVET_RIPGREP_PATH env（调试/覆盖）> 自带 rg（RIVET_BUNDLED_RIPGREP_DIR，
 * 桌面端打包时由 Rust 注入，架构与目标平台匹配）> 系统 PATH 的 'rg'。
 *
 * 关键：每个候选首次解析时跑一次 rg --version 探活。系统 rg 可能架构不符
 * （如 ARM64 rg 在 x64 机器上报 Exec format error）——此前这种情况被静默吞掉，
 * grep 降级到慢速遍历。现在探活失败会记录具体原因并尝试下一个候选，debugLog
 * 里能看到"Exec format error"而非笼统的"未找到"。
 *
 * 结果缓存到 rgResolvedPath，同进程内不重复探活。
 */
let rgResolvedPath: string | null | undefined
let rgResolveInFlight: Promise<string | null> | undefined

/** 清空 rg 解析缓存（测试用）——置回未解析态，下次调用重新探活。
 *  模块级缓存跨测试存活：顺序依赖的测试（如"rg 不可用"回退路径）必须在
 *  开头清缓存、结尾恢复，否则前面测试解析出的路径会污染断言（2026-08-25
 *  grep.test.ts slow-fallback 顺序依赖失败）。 */
export function resetRgResolvedPath(): void {
  rgResolvedPath = undefined
  rgResolveInFlight = undefined
}

/** 异步探活版 rg 解析——execFile 探 --version 不占事件循环。同步 execFileSync
 *  探活（5s 超时）是蜂群冷启动路径上的阻塞点：冷盘/杀毒扫描的 Windows 上
 *  单次即卡满超时窗（2026-08-24 /scout 卡死事故线）。结果仍进程级缓存
 *  （成功与失败都缓存）；并发首调共享同一 in-flight promise。 */
async function resolveRgPath(): Promise<string | null> {
  if (rgResolvedPath !== undefined) return rgResolvedPath
  if (rgResolveInFlight) return rgResolveInFlight
  rgResolveInFlight = (async () => {
    const ext = process.platform === 'win32' ? '.exe' : ''
    const candidates: { path: string; label: string }[] = []

    // 1. RIVET_RIPGREP_PATH（显式覆盖，不探活——用户说啥是啥）
    const override = process.env.RIVET_RIPGREP_PATH
    if (override) {
      rgResolvedPath = override
      return override
    }

    // 2. 自带 rg（RIVET_BUNDLED_RIPGREP_DIR，桌面端打包注入）
    const bundledDir = process.env.RIVET_BUNDLED_RIPGREP_DIR
    if (bundledDir) {
      const bundledRg = bundledDir + require('path').sep + 'rg' + ext
      if (existsSync(bundledRg)) candidates.push({ path: bundledRg, label: 'bundled' })
    }

    // 3. 系统 PATH 的 rg（裸 'rg'，spawn 时由 PATH 解析）
    candidates.push({ path: 'rg', label: 'system' })

    // 探活：跑 rg --version，第一个成功的即为结果。
    for (const c of candidates) {
      try {
        await execFileAsync(c.path, ['--version'], { timeout: 5_000, windowsHide: true })
        debugLog(`[grep] rg resolved: ${c.label} (${c.path})`)
        rgResolvedPath = c.path
        return c.path
      } catch (err) {
        debugLog(`[grep] rg candidate ${c.label} (${c.path}) failed probe: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    debugLog('[grep] no usable rg found after probing all candidates')
    rgResolvedPath = null
    return null
  })()
  try {
    return await rgResolveInFlight
  } finally {
    rgResolveInFlight = undefined
  }
}

async function tryRipgrep(
  pattern: string,
  absPath: string,
  searchPath: string,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  literal: boolean,
  contextLines: number,
  modelCap: ModelReadCap,
  artifactStore?: ArtifactStore,
  artifactThreshold: number = 0,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<ToolResult | null> {
  try {
    const binary = await resolveRgPath()
    if (!binary) return null
    const { lines, truncated } = await searchReadableFilesWithRipgrep({
      binary, cwd, path: absPath, pattern, glob, literal, contextLines,
      maxResults, timeoutMs: TIMEOUT_MS, signal: abortSignal,
    })
    if (lines.length === 0) return { content: GREP_EMPTY_RESULT }
    const text = lines.join('\n') + (truncated ? '\n...（已截断）' : '')
    let hintedText = appendLogRangeHints(text, searchPath)
    hintedText = await appendHashEditHints(hintedText, absPath, cwd, sessionId)
    await registerGrepFilesFromOutput(hintedText, cwd, sessionId)
    if (artifactStore && hintedText.length >= artifactThreshold) {
      const { summary, sections } = summarizeGrepResult(hintedText, pattern)
      try {
        const artifactId = await artifactStore.save({ tool: 'grep', target: absPath, rawContent: hintedText, summary, sections })
        const text = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
        return { content: `${text}\n\n${summary}\n使用 read_section(artifactId="${artifactId}", section="L1-L500") 获取完整匹配列表。\n[artifact:${artifactId}]` }
      } catch { /* use the bounded inline result */ }
    }
    return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
  } catch (error) {
    debugLog(`[grep] rg fallback: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

interface NativeSearchOutcome {
  results: string[]
  /** Non-null when the walk or a file scan ended early — results are partial. */
  incompleteReason: string | null
}

interface NativeSearchOptions {
  signal?: AbortSignal
  /** Absolute wall-clock deadline shared by the whole walk. */
  deadlineAt?: number
}

async function nativeSearch(
  absPath: string,
  pattern: GrepPattern,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  contextLines: number = 0,
  options: NativeSearchOptions = {},
): Promise<NativeSearchOutcome> {
  const filter = await GitignoreFilter.create(cwd)
  const globRegex = glob ? globToRegex(glob) : null
  const results: string[] = []
  const visited = new Set<string>()
  // Same budget ripgrep gets. Without one this walk is unbounded: it is only
  // reached when rg is missing or already timed out, i.e. exactly when the tree
  // is hostile.
  const deadlineAt = options.deadlineAt ?? Date.now() + TIMEOUT_MS
  let incompleteReason: string | null = null

  /** Budget left for the next bounded file scan. */
  function remainingMs(): number {
    return Math.max(0, deadlineAt - Date.now())
  }

  /** Deadline check that latches the reason, so it survives the unwind. */
  function outOfTime(): boolean {
    if (Date.now() < deadlineAt) return false
    incompleteReason ??= 'deadline'
    return true
  }

  const aborted = (): boolean => {
    if (!options.signal?.aborted) return false
    incompleteReason ??= 'aborted'
    return true
  }

  /** Scan one file with the shared budget; never materialises the whole file. */
  async function scanOne(fullPath: string): Promise<FileSearchOutcome> {
    return searchFile(fullPath, pattern, maxResults - results.length, contextLines, {
      signal: options.signal,
      deadlineMs: remainingMs(),
    })
  }

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    if (results.length >= maxResults) return
    if (outOfTime() || aborted()) return

    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      // Non-root + known restricted system path + permission error → silent skip.
      // Root or other errors → propagate (outer catch → isError:true).
      if (!isRoot && isRestrictedPath(String(e.path ?? e.message ?? ''), e.code ?? '')) return
      throw err
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (outOfTime() || aborted()) return
      // Prune before the lstat. Descending costs a readdir plus an lstat for
      // every entry below, and the per-file gitignore check further down cannot
      // refund any of it — it runs after the walk has already paid.
      if (entry.isDirectory() && isScanExcludedDir(entry.name)) continue
      const fullPath = join(dir, entry.name)
      const s = await lstat(fullPath).catch(() => null)
      if (!s || s.isSymbolicLink()) continue

      if (s.isDirectory()) {
        await walk(fullPath, false)
      } else if (s.isFile()) {
        const relPath = relativePosix(cwd, fullPath)
        if (filter.isIgnored(cwd, fullPath)) continue
        if (globRegex && !globRegex.test(entry.name)) continue

        if (!validatePathSafe(cwd, fullPath).ok) continue
        const matched = await scanOne(fullPath)
        if (matched.incomplete) incompleteReason ??= matched.incomplete
        for (const line of matched.lines) {
          results.push(`${relPath}:${line}`)
          if (results.length >= maxResults) return
        }
      }
    }
  }

  const s = await lstat(absPath).catch(() => null)
  if (s?.isFile()) {
    const relPath = relativePosix(cwd, absPath)
    const matched = await scanOne(absPath)
    if (matched.incomplete) incompleteReason ??= matched.incomplete
    for (const line of matched.lines) {
      results.push(`${relPath}:${line}`)
      if (results.length >= maxResults) break
    }
  } else {
    await walk(absPath, true)
  }

  return { results, incompleteReason }
}

interface FileSearchOutcome {
  lines: string[]
  /** Non-null when the scan did not cover the whole file. */
  incomplete: string | null
}

interface GrepPattern {
  /** Pattern source as the model wrote it. */
  source: string
  literal: boolean
}

interface ScanOutcome {
  lines: MatchLine[]
  matchCount: number
  stoppedReason: string
  lineTooLongCount: number
}

/** Soft budget for the isolated regex scan; the pool's hard ceiling kills a
 *  worker that is still spinning (catastrophic backtracking). */
const REGEX_SCAN_SOFT_TIMEOUT_MS = 5_000

/**
 * Regex scans run in the CPU worker. Returns null when the pool could not run
 * at all (disabled / worker load failure / worker crash) so the caller degrades
 * to an inline scan — such a fault is NOT a pathological pattern and must not
 * be reported as one. Only our own soft timeout produces a `regexTimeout`
 * outcome: the regex is spinning, and re-running it on the main thread is
 * exactly what this isolation prevents.
 */
async function isolatedRegexScan(
  filePath: string,
  source: string,
  contextLines: number,
  maxMatches: number,
  maxLineChars: number,
  budget: ScanBudget,
): Promise<ScanOutcome | null> {
  if (budget.signal?.aborted) {
    return { lines: [], matchCount: 0, stoppedReason: 'aborted', lineTooLongCount: 0 }
  }
  // Bound the in-worker scan by the walk's remaining deadline, never longer
  // than the pool's soft budget. An AbortSignal cannot cross the thread
  // boundary; a mid-scan abort is bounded by the soft timeout instead.
  const deadlineMs = Math.min(
    REGEX_SCAN_SOFT_TIMEOUT_MS,
    budget.deadlineMs !== undefined ? Math.max(0, budget.deadlineMs) : REGEX_SCAN_SOFT_TIMEOUT_MS,
  )
  try {
    const res = await cpuPool.run(
      'grepScanRaw',
      [filePath, source, '', contextLines, maxMatches, maxLineChars, deadlineMs],
      REGEX_SCAN_SOFT_TIMEOUT_MS,
    ) as GrepScanRawResult
    return res
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/timed out after/i.test(message)) {
      return { lines: [], matchCount: 0, stoppedReason: 'regexTimeout', lineTooLongCount: 0 }
    }
    return null
  }
}

/**
 * Bounded single-file search. Replaces the old whole-file `allLines` buffer:
 * only matches (plus a bounded context window) are retained, so peak memory no
 * longer grows with the number of lines scanned.
 */
async function searchFile(
  filePath: string,
  pattern: GrepPattern,
  remaining = Number.POSITIVE_INFINITY,
  contextLines = 0,
  budget: ScanBudget = {},
): Promise<FileSearchOutcome> {
  const maxMatches = Number.isFinite(remaining)
    ? Math.max(1, Math.floor(remaining))
    : Number.MAX_SAFE_INTEGER
  const maxLineChars = budget.maxLineChars ?? DEFAULT_MAX_LINE_CHARS

  // Literal patterns cannot backtrack → scan inline. Regex patterns run in the
  // CPU worker so catastrophic backtracking blocks that thread, not the main
  // event loop; a timeout is reported, never recomputed here.
  let outcome: ScanOutcome | null = pattern.literal
    ? null
    : await isolatedRegexScan(filePath, pattern.source, contextLines, maxMatches, maxLineChars, budget)
  if (outcome === null) {
    const regex = buildRegex(pattern.source, pattern.literal)
    if (!regex) return { lines: [], incomplete: 'syntax_error' }
    const res = await scanForMatches(filePath, line => regex.test(line), {
      contextLines,
      maxMatches,
      budget,
    })
    outcome = {
      lines: res.lines,
      matchCount: res.matchCount,
      stoppedReason: res.stoppedReason,
      lineTooLongCount: res.lineTooLongCount,
    }
  }

  const lines = contextLines <= 0
    ? outcome.lines.filter(l => l.isMatch).map(l => `${l.lineNumber}:  ${l.text}`)
    : formatContextLines(outcome.lines)

  const incomplete = outcome.stoppedReason === 'lineTooLong'
    || outcome.stoppedReason === 'deadline'
    || outcome.stoppedReason === 'aborted'
    || outcome.stoppedReason === 'regexTimeout'
    ? outcome.stoppedReason
    : null
  return { lines, incomplete }
}

function formatContextLines(matchLines: MatchLine[]): string[] {
  const out: string[] = []
  let prev = -1
  for (const l of matchLines) {
    if (prev !== -1 && l.lineNumber > prev + 1) out.push('  ...')
    out.push(`${l.isMatch ? '>' : ' '}${String(l.lineNumber).padStart(4)}│ ${l.text}`)
    prev = l.lineNumber
  }
  return out
}

function globToRegex(glob: string): RegExp {
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/)
  let patterns: string[]
  if (braceMatch) {
    const [, prefix, group, suffix] = braceMatch
    const options = group!.split(',')
    patterns = options.map(o => prefix! + o + suffix!)
  } else {
    patterns = [glob]
  }

  const regexes = patterns.map(p =>
    p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.'),
  )
  return new RegExp(`^(${regexes.join('|')})$`)
}
