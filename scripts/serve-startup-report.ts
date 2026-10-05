/**
 * serve 启动量尺（dist 形态）：静态闭包 + 独立进程 import 耗时 + `--spawn` 启动时间线。
 *
 * 用法：
 *   npx tsx scripts/serve-startup-report.ts [--dist dist] [--entry <file>] [--runs 7] [--why <chunk>] [--json]
 *   npx tsx scripts/serve-startup-report.ts --spawn [--kill-after-agent] [--warm-delay <ms>] [--keep-temp]
 *
 * - 静态闭包：从 dist 里 serve 的动态入口 facade（`serve-*.js`）出发，跟静态
 *   `import/export ... from`，动态 import() 不算——与源码扫描器同口径。
 * - import 耗时：无缓存 / 冷缓存（每次新目录）/ 热缓存（先跑一次再测）三组，
 *   报 min / p50 / p90 / max（dist 未混淆）。
 * - --spawn：用临时 HOME + RIVET_HOME + 临时 cwd 启 `cli/entry.js serve`（绝不碰
 *   真实 ~/.rivet / 真实仓库；子进程环境走白名单，不带 provider key 等），解析
 *   `[serve-timing]` 阶段；`--kill-after-agent` 会等
 *   `serve-agent-loaded` 后 SIGKILL，再用同一 HOME/缓存目录启动第二次，对比
 *   硬杀后的冷热。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const SERVE_TIMING_PREFIX = '[serve-timing]'
const MARK_RE = /\[serve-timing\] phase=(\S+) \+(\d+)ms(?:\s+(.*))?$/

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mib = bytes / 1024 / 1024
  if (mib >= 1) return `${mib.toFixed(2)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

/** tsup 把动态 import 的 serve.ts 产出成 `<dist>/serve-<hash>.js` facade（或在 dist/server/serve.js）。 */
export function findServeDistEntry(distDir: string): string {
  const direct = join(distDir, 'server', 'serve.js')
  if (existsSync(direct)) return direct
  const dynamicRefs = new Set<string>()
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue
    const text = readFileSync(join(distDir, file), 'utf8')
    for (const m of text.matchAll(/await import\("\.\/(serve-[A-Z0-9]+\.js)"\)/g)) dynamicRefs.add(m[1]!)
  }
  if (dynamicRefs.size === 1) return join(distDir, [...dynamicRefs][0]!)
  const facades = readdirSync(distDir).filter(f => /^serve-[A-Z0-9]+\.js$/.test(f)).sort()
  if (facades.length > 0) return join(distDir, facades[0]!)
  throw new Error(`找不到 serve 的 dist 动态入口（已找过 ${distDir}/server/serve.js 与 serve-*.js）`)
}

export interface DistClosure {
  entry: string
  files: Map<string, number>
  bytes: number
  parentOf: Map<string, string | null>
  why(target: string): string[]
}

/** 压缩/混淆形态签名（格式化代码不会长这样）：import{ / import" / from"。 */
const COMPACT_IMPORT_SIGNATURE = /(?<![\w$.])import(?:\{|["'])|(?<![\w$.])from["']/

/**
 * 从 dist chunk 提取**全部**静态 import/export-from 的 specifier：相对路径、bare
 * 包、`node:` 内置都返回；调用方自行过滤（闭包解析只跟相对路径）。
 *
 * 兼容两类形态：
 * - 常规：`import { a } from "./x.js"` / `export * from "./y.js"`；
 * - 混淆/压缩：`import{a as b}from"./x.js"`（import/from 后无空白）；
 *   只引内置模块的紧凑 chunk（`import{createRequire}from"node:module"`）同样要吐出来——
 *   fail-loud 守卫必须看这张全集，否则会把合法的「仅内置」chunk 误判成解析失败。
 * 动态 `import(` 不算（`(?!\()` 守卫）。
 */
export function extractDistStaticSpecifiers(source: string): string[] {
  const out = new Set<string>()
  const importRe = /(?<![\w$.])import\s*(?!\()(?:[^'"]*?\s*from\s*)?['"]([^'"]+)['"]/g
  const exportRe = /(?<![\w$.])export\s*(?:\*|\{[^}]*\})(?:\s*as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g
  for (const m of source.matchAll(importRe)) out.add(m[1]!)
  for (const m of source.matchAll(exportRe)) out.add(m[1]!)
  return [...out]
}

/** dist 静态闭包：只跟 `import/export ... from`，不跟动态 import()。 */
export function analyzeDistClosure(entry: string): DistClosure {
  const files = new Map<string, number>()
  const parentOf = new Map<string, string | null>()
  const statCache = new Map<string, number>()
  const size = (p: string): number => {
    const hit = statCache.get(p)
    if (hit !== undefined) return hit
    let n = 0
    try { n = statSync(p).size } catch { n = 0 }
    statCache.set(p, n)
    return n
  }
  const entryAbs = resolve(entry)
  files.set(entryAbs, size(entryAbs))
  parentOf.set(entryAbs, null)
  const queue = [entryAbs]
  while (queue.length > 0) {
    const file = queue.shift()!
    let source: string
    try { source = readFileSync(file, 'utf8') } catch { continue }
    const specs = extractDistStaticSpecifiers(source)
    if (specs.length === 0 && COMPACT_IMPORT_SIGNATURE.test(source)) {
      // 解析器落后于新的压缩/混淆形态时，闭包会静默只剩入口一个文件——宁可 fail loud。
      throw new Error(`dist 闭包解析器未能识别 ${file} 的 import 语法（疑似新的压缩/混淆形态）；数字不可信，请先修 scripts/serve-startup-report.ts`)
    }
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      if (files.has(target) || !existsSync(target)) continue
      files.set(target, size(target))
      parentOf.set(target, file)
      queue.push(target)
    }
  }
  let bytes = 0
  for (const n of files.values()) bytes += n
  const why = (target: string): string[] => {
    let abs = resolve(target)
    if (!files.has(abs)) {
      const needle = target.split('\\').join('/')
      for (const candidate of files.keys()) {
        if (relative(dirname(entryAbs), candidate).split('\\').join('/') === needle || candidate.split('\\').join('/').endsWith(`/${needle}`)) { abs = candidate; break }
      }
    }
    if (!files.has(abs)) return []
    const chain: string[] = []
    let cursor: string | null | undefined = abs
    while (cursor) {
      chain.push(relative(dirname(entryAbs), cursor).split('\\').join('/'))
      cursor = parentOf.get(cursor) ?? null
    }
    return chain.reverse()
  }
  return { entry: entryAbs, files, bytes, parentOf, why }
}

interface TimingSample { wallMs: number; innerMs: number }

function runImportOnce(entry: string, cache: { mode: 'none' | 'cache'; dir?: string }): TimingSample {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_COMPILE_CACHE
  delete env.NODE_DISABLE_COMPILE_CACHE
  if (cache.mode === 'cache' && cache.dir) {
    env.NODE_COMPILE_CACHE = cache.dir
  } else {
    env.NODE_DISABLE_COMPILE_CACHE = '1'
  }
  const code = [
    `const t = performance.now();`,
    `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    `process.stdout.write('__RIVET_REPORT__' + JSON.stringify({ innerMs: performance.now() - t }));`,
  ].join('\n')
  const t0 = performance.now()
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 120_000, windowsHide: true })
  const wallMs = performance.now() - t0
  const match = result.stdout?.match(/__RIVET_REPORT__(\{.*\})/)
  const innerMs = match ? (JSON.parse(match[1]!) as { innerMs: number }).innerMs : NaN
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`import 子进程退出码 ${result.status}: ${result.stderr?.slice(0, 500)}`)
  return { wallMs, innerMs }
}

function stats(values: number[]): { min: number; p50: number; p90: number; max: number } {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN
  return { min: sorted[0] ?? NaN, p50: pick(0.5), p90: pick(0.9), max: sorted[sorted.length - 1] ?? NaN }
}

function formatStats(s: { min: number; p50: number; p90: number; max: number }): string {
  return `min=${s.min.toFixed(1)} p50=${s.p50.toFixed(1)} p90=${s.p90.toFixed(1)} max=${s.max.toFixed(1)}`
}

export interface TimingReport {
  noCache: TimingSample[]
  coldCache: TimingSample[]
  hotCache: TimingSample[]
  stats: {
    noCache: ReturnType<typeof stats>
    coldCache: ReturnType<typeof stats>
    hotCache: ReturnType<typeof stats>
  }
}

function measureImport(entry: string, runs: number, tempRoot: string): TimingReport {
  const noCache: TimingSample[] = []
  for (let i = 0; i < runs; i++) noCache.push(runImportOnce(entry, { mode: 'none' }))
  const coldCache: TimingSample[] = []
  for (let i = 0; i < runs; i++) {
    const dir = mkdtempSync(join(tempRoot, 'cold-'))
    coldCache.push(runImportOnce(entry, { mode: 'cache', dir }))
    rmSync(dir, { recursive: true, force: true })
  }
  const hotDir = mkdtempSync(join(tempRoot, 'hot-'))
  runImportOnce(entry, { mode: 'cache', dir: hotDir }) // 预热：正常退出写盘
  const hotCache: TimingSample[] = []
  for (let i = 0; i < runs; i++) hotCache.push(runImportOnce(entry, { mode: 'cache', dir: hotDir }))
  rmSync(hotDir, { recursive: true, force: true })
  return {
    noCache, coldCache, hotCache,
    stats: { noCache: stats(noCache.map(s => s.wallMs)), coldCache: stats(coldCache.map(s => s.wallMs)), hotCache: stats(hotCache.map(s => s.wallMs)) },
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePromise(port))
    })
  })
}

interface SpawnRun {
  port: number
  marks: Map<string, { plusMs: number; extra?: string; wallMs: number }>
  lines: string[]
  exited: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface ServeHandle {
  run: SpawnRun
  child: ChildProcess
  kill: (signal?: NodeJS.Signals) => void
  waitExit: () => Promise<void>
}

async function startServe(options: {
  distDir: string
  cwd: string
  env: NodeJS.ProcessEnv
  port: number
  waitFor: string[]
  timeoutMs: number
  /** 子进程一落地就交给调用方登记（异常路径统一回收）。 */
  onSpawn?: (child: ChildProcess) => void
}): Promise<ServeHandle> {
  const entry = join(options.distDir, 'cli', 'entry.js')
  const t0 = performance.now()
  const child = spawn(process.execPath, [entry, 'serve', '--port', String(options.port)], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  options.onSpawn?.(child)
  const run: SpawnRun = { port: options.port, marks: new Map(), lines: [], exited: false, exitCode: null, signal: null }
  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej })
  const pending = new Set(options.waitFor)
  const onLine = (line: string): void => {
    run.lines.push(line)
    const m = MARK_RE.exec(line)
    if (!m) return
    const name = m[1]!
    run.marks.set(name, { plusMs: Number(m[2]), extra: m[3], wallMs: performance.now() - t0 })
    pending.delete(name)
    if (pending.size === 0) resolveDone()
  }
  const consume = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) onLine(line.trim())
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  child.on('error', err => rejectDone(err))
  child.on('exit', (code, signal) => {
    run.exited = true
    run.exitCode = code
    run.signal = signal
    if (pending.size > 0) rejectDone(new Error(`serve 在等待 ${[...pending].join(',')} 时退出 code=${code} signal=${signal}\n${run.lines.slice(-20).join('\n')}`))
    else resolveDone()
  })
  const timer = setTimeout(() => rejectDone(new Error(`等待 ${[...pending].join(',')} 超时（${options.timeoutMs}ms）`)), options.timeoutMs)
  timer.unref?.()
  try {
    await done
  } catch (err) {
    // 等待失败（超时/早退）不能把 sidecar 留在后台：它的临时 HOME 马上要被删。
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    throw err
  } finally {
    clearTimeout(timer)
  }
  return {
    run,
    child,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => { try { child.kill(signal) } catch { /* already gone */ } },
    waitExit: async () => {
      if (run.exited) return
      await new Promise<void>((res) => child.once('exit', () => res()))
    },
  }
}

function printStages(run: SpawnRun): void {
  const ordered = [...run.marks.entries()].sort((a, b) => a[1].wallMs - b[1].wallMs)
  let prev = 0
  for (const [phase, mark] of ordered) {
    const delta = mark.plusMs - prev
    prev = mark.plusMs
    console.log(`  ${phase.padEnd(20)} +${String(mark.plusMs).padStart(5)}ms  (Δ${String(Math.round(delta)).padStart(4)}ms, spawn→${Math.round(mark.wallMs)}ms)${mark.extra ? `  ${mark.extra}` : ''}`)
  }
}

const DEFAULT_PHASE_TIMEOUT_MS = 120_000

async function waitForPhase(run: SpawnRun, phase: string, timeoutMs = DEFAULT_PHASE_TIMEOUT_MS): Promise<{ plusMs: number; wallMs: number }> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const mark = run.marks.get(phase)
    if (mark) return mark
    if (run.exited) throw new Error(`等待 ${phase} 时 serve 已退出 code=${run.exitCode}`)
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`等待 ${phase} 超时`)
}

/** 有界停：SIGTERM 后最多等 timeoutMs，到点升级 SIGKILL——sidecar 卡死时量尺
 *  不能永远挂着，否则 finally 的子进程回收与临时目录清理都轮不到执行。 */
async function stopServe(handle: ServeHandle, timeoutMs = 3_000): Promise<void> {
  if (handle.run.exited) return
  handle.kill('SIGTERM')
  const hard = setTimeout(() => handle.kill('SIGKILL'), timeoutMs)
  hard.unref?.()
  try {
    await handle.waitExit()
  } finally {
    clearTimeout(hard)
  }
}

async function createSessionAt(port: number, token: string, cwd: string): Promise<{ ms: number; status: number; id?: string }> {
  const t0 = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ cwd }),
  })
  const ms = performance.now() - t0
  const body = await res.json().catch(() => null) as { id?: string } | null
  return { ms, status: res.status, id: body?.id }
}

/** 发送一条首轮消息：createAgent 路径会 fireNow 暖场——用于量「暖场前首个 createAgent 的等待」。 */
async function promptSessionAt(port: number, token: string, id: string, prompt: string): Promise<{ ms: number; status: number }> {
  const t0 = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt }),
  })
  const ms = performance.now() - t0
  await res.text()
  return { ms, status: res.status }
}

/** 在 [listen, stopPhase] 窗口内轮询 /health：拉长的响应间隔≈暖场 import 阻塞主线程的时长。 */
async function probeHealthDuringWarmup(port: number, run: SpawnRun, stopPhase: string, token: string): Promise<{ samples: number[] }> {
  const samples: number[] = []
  const deadline = performance.now() + 120_000
  while (!run.marks.has(stopPhase) && !run.exited && performance.now() < deadline) {
    const t0 = performance.now()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } })
      await res.text()
    } catch { /* 阻塞/未就绪都按时长记 */ }
    samples.push(performance.now() - t0)
    await new Promise(r => setTimeout(r, 5))
  }
  return { samples }
}

/**
 * --spawn 子进程环境白名单：只给启动必需项，**不继承整张环境表**。
 * 否则 provider key 会被带进去（`--create-session-early` 的 probe prompt 会变成
 * 一次真实模型请求），RIVET_SESSION_DIR 之类的变量也会指回真实目录。
 */
export function serveSpawnEnv(home: string, rivetHome: string, cacheDir: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home, // Windows 上 Node 的 os.homedir() 认这个
    RIVET_HOME: rivetHome,
    NODE_COMPILE_CACHE: cacheDir,
    RIVET_SERVE_TIMING: '1',
    RIVET_SERVER_TOKEN: token,
  }
  // 宿主探针（where/reg）、子进程查找与 locale 的最小必需集。
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

async function spawnFlow(options: {
  distDir: string
  killAfterAgent: boolean
  healthProbe: boolean
  createSessionEarly: boolean
  warmDelayMs?: number
  /** 等待 listen / serve-agent-loaded 等阶段的上限（默认 120s），故障注入用。 */
  phaseTimeoutMs?: number
  keepTemp: boolean
}): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'rivet-serve-report-'))
  const home = join(tempRoot, 'home')
  const rivetHome = join(tempRoot, 'rivet-home')
  const cacheDir = join(tempRoot, 'compile-cache')
  const workdir = join(tempRoot, 'workdir')
  mkdirSync(home, { recursive: true })
  mkdirSync(rivetHome, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(workdir, { recursive: true })
  const token = `report-${Date.now().toString(36)}`
  const baseEnv = serveSpawnEnv(home, rivetHome, cacheDir, token)
  const envWithWarm = (delayMs?: number): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...baseEnv }
    if (delayMs !== undefined) env.RIVET_SERVE_WARM_DELAY_MS = String(delayMs)
    return env
  }
  const liveChildren = new Set<ChildProcess>()
  const onSpawn = (child: ChildProcess): void => {
    liveChildren.add(child)
    child.once('exit', () => liveChildren.delete(child))
  }
  console.log(`temp HOME=${home}`)
  console.log(`temp RIVET_HOME=${rivetHome}`)
  console.log(`temp workdir=${workdir}`)
  console.log(`NODE_COMPILE_CACHE=${cacheDir}`)
  try {
    if (options.createSessionEarly) {
      const earlyDelay = options.warmDelayMs ?? 30_000
      const p1 = await freePort()
      console.log(`\n[start #1] serve --port ${p1}（RIVET_SERVE_WARM_DELAY_MS=${earlyDelay}，listen 后立即建会话）`)
      const s1 = await startServe({ distDir: options.distDir, cwd: workdir, env: envWithWarm(earlyDelay), port: p1, waitFor: ['listen'], timeoutMs: options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS, onSpawn })
      const r1 = await createSessionAt(p1, token, workdir)
      console.log(`  首个 POST /sessions（暖场点火前）：${r1.ms.toFixed(1)}ms (status ${r1.status})`)
      if (r1.id) {
        const m1 = await promptSessionAt(p1, token, r1.id, 'startup probe: reply OK')
        console.log(`  首个 POST /prompt（触发 createAgent）：${m1.ms.toFixed(1)}ms (status ${m1.status})`)
      }
      await waitForPhase(s1.run, 'serve-agent-loaded', options.phaseTimeoutMs)
      printStages(s1.run)
      const ws1 = s1.run.marks.get('warm-start')
      const al1 = s1.run.marks.get('serve-agent-loaded')
      if (ws1 && al1) console.log(`  → 暖场点火到 agent 可用：${al1.plusMs - ws1.plusMs}ms（首个 createAgent 的额外等待）`)
      await stopServe(s1)

      const p2 = await freePort()
      console.log(`\n[start #2] serve --port ${p2}（RIVET_SERVE_WARM_DELAY_MS=0，等 serve-agent-loaded 后建会话）`)
      const s2 = await startServe({ distDir: options.distDir, cwd: workdir, env: envWithWarm(0), port: p2, waitFor: ['listen'], timeoutMs: options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS, onSpawn })
      await waitForPhase(s2.run, 'serve-agent-loaded', options.phaseTimeoutMs)
      const r2 = await createSessionAt(p2, token, workdir)
      console.log(`  首个 POST /sessions（暖场完成后）：${r2.ms.toFixed(1)}ms (status ${r2.status})`)
      if (r2.id) {
        const m2 = await promptSessionAt(p2, token, r2.id, 'startup probe: reply OK')
        console.log(`  首个 POST /prompt（agent 已暖）：${m2.ms.toFixed(1)}ms (status ${m2.status})`)
      }
      printStages(s2.run)
      const ws2 = s2.run.marks.get('warm-start')
      const al2 = s2.run.marks.get('serve-agent-loaded')
      if (ws2 && al2) console.log(`  → 暖场点火到 agent 可用：${al2.plusMs - ws2.plusMs}ms`)
      console.log(`\n暖场前建会话：首条消息线上等待 ${ws1 && al1 ? al1.plusMs - ws1.plusMs : -1}ms；暖场后 ${ws2 && al2 ? al2.plusMs - ws2.plusMs : -1}ms`)
      await stopServe(s2)
      return
    }

    const firstPort = await freePort()
    console.log(`\n[start #1] serve --port ${firstPort}${options.killAfterAgent ? '（等 serve-agent-loaded 后 SIGKILL）' : ''}`)
    const first = await startServe({ distDir: options.distDir, cwd: workdir, env: envWithWarm(options.warmDelayMs), port: firstPort, waitFor: ['listen'], timeoutMs: options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS, onSpawn })
    const probePromise = options.healthProbe ? probeHealthDuringWarmup(firstPort, first.run, 'serve-agent-loaded', token) : null
    if (options.killAfterAgent || options.healthProbe) await waitForPhase(first.run, 'serve-agent-loaded', options.phaseTimeoutMs)
    if (probePromise) {
      const { samples } = await probePromise
      const probeStats = stats(samples)
      console.log(`  /health 探测（listen→agent-loaded，n=${samples.length}）：min=${probeStats.min.toFixed(1)} p50=${probeStats.p50.toFixed(1)} p90=${probeStats.p90.toFixed(1)} max=${probeStats.max.toFixed(1)}ms（max≈暖场阻塞主线程）`)
    }
    printStages(first.run)
    if (options.killAfterAgent) {
      first.kill('SIGKILL')
      await first.waitExit()
      console.log('  → SIGKILL 已发出（模拟桌面壳硬杀 sidecar）')
      const secondPort = await freePort()
      console.log(`\n[start #2] serve --port ${secondPort}（同一 HOME/缓存目录，冷热对比）`)
      const second = await startServe({ distDir: options.distDir, cwd: workdir, env: envWithWarm(options.warmDelayMs), port: secondPort, waitFor: ['listen'], timeoutMs: options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS, onSpawn })
      await waitForPhase(second.run, 'serve-agent-loaded', options.phaseTimeoutMs)
      printStages(second.run)
      second.kill('SIGKILL')
      await second.waitExit()
      const a = first.run.marks.get('serve-agent-loaded')
      const b = second.run.marks.get('serve-agent-loaded')
      if (a && b) console.log(`\nserve-agent-loaded: #1 +${a.plusMs}ms → #2 +${b.plusMs}ms（差 ${b.plusMs - a.plusMs >= 0 ? '+' : ''}${b.plusMs - a.plusMs}ms）`)
      const aStart = first.run.marks.get('start')
      const bStart = second.run.marks.get('start')
      if (aStart && bStart) console.log(`start 标记 uptime: #1 ${aStart.extra} → #2 ${bStart.extra}`)
    } else {
      await stopServe(first)
    }
  } finally {
    // 任何等待/HTTP 失败路径都不能把 sidecar 留在后台——它的 HOME 马上要被删。
    for (const child of liveChildren) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    if (liveChildren.size > 0) await new Promise(r => setTimeout(r, 100))
    if (!options.keepTemp) rmSync(tempRoot, { recursive: true, force: true })
    else console.log(`\n--keep-temp：保留 ${tempRoot}`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npx tsx scripts/serve-startup-report.ts [--dist dist] [--entry <file>] [--runs 7] [--why <chunk>] [--json] [--spawn [--kill-after-agent] [--health-probe] [--create-session-early] [--warm-delay <ms>] [--phase-timeout <ms>] [--keep-temp]]')
    return
  }
  const cwd = process.cwd()
  const distDir = resolve(cwd, arg('--dist') ?? 'dist')
  const entry = resolve(cwd, arg('--entry') ?? findServeDistEntry(distDir))
  const json = argv.includes('--json')
  const runs = Number(arg('--runs') ?? '7')

  if (argv.includes('--spawn')) {
    void spawnFlow({
      distDir,
      killAfterAgent: argv.includes('--kill-after-agent'),
      healthProbe: argv.includes('--health-probe'),
      createSessionEarly: argv.includes('--create-session-early'),
      warmDelayMs: arg('--warm-delay') !== undefined ? Number(arg('--warm-delay')) : undefined,
      phaseTimeoutMs: arg('--phase-timeout') !== undefined ? Number(arg('--phase-timeout')) : undefined,
      keepTemp: argv.includes('--keep-temp'),
    }).catch(err => { console.error(err); process.exitCode = 1 })
    return
  }

  const closure = analyzeDistClosure(entry)
  const tempRoot = mkdtempSync(join(tmpdir(), 'rivet-import-timing-'))
  let timing: TimingReport
  try {
    timing = measureImport(entry, runs, tempRoot)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
  const why = arg('--why')
  if (json) {
    console.log(JSON.stringify({
      entry: relative(cwd, entry),
      closure: { files: closure.files.size, bytes: closure.bytes },
      timing,
    }, null, 2))
    return
  }
  console.log(`dist serve entry: ${relative(cwd, entry)}`)
  console.log(`静态闭包：${closure.files.size} files / ${formatBytes(closure.bytes)}`)
  const top = [...closure.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  for (const [path, size] of top) console.log(`  ${formatBytes(size).padStart(10)}  ${relative(cwd, path)}`)
  if (why) {
    const chain = closure.why(why)
    console.log(chain.length > 0 ? `why ${why}:\n  ← ${chain.join('\n  ← ')}` : `${why} 不在静态闭包内`)
  }
  console.log(`\nimport 耗时（${runs} 次，wall=进程启动到退出，inner=进程内 import）：`)
  for (const [name, samples] of [['无缓存', timing.noCache], ['冷缓存', timing.coldCache], ['热缓存', timing.hotCache]] as const) {
    const wall = stats(samples.map(s => s.wallMs))
    const inner = stats(samples.map(s => s.innerMs))
    console.log(`  ${name}  wall ${formatStats(wall)} | inner ${formatStats(inner)}`)
  }
}

const invokedAsCli = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invokedAsCli) main()
