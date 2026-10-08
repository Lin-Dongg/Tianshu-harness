import { basename } from 'node:path'
import { classifyVerificationCommand, verificationArgv } from '../tools/verification-command.js'
import { applyBatchCounts, type TestCounts } from '../tools/test-output-counts.js'
import { completionFacts } from '../tools/verification-facts.js'
import { unwrapVerification } from '../tools/verification-invocation.js'
import type { ToolResult, VerificationMetadata } from '../tools/types.js'

/** 受支持运行器出现在**命令位置**（段首，可带 cd/rtk/npx 前缀）的判据。
 *  先剥离引号内容——`grep -rn "npm test" src/` 是查询，不是验证。 */
const VERIFICATION_SEGMENT = /(?:^|[;&|]\s*)(?:cd\s+[^\s;|&]+\s*&&\s*)?(?:rtk\s+(?:proxy\s+)?)?(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|build))\b|(?:npx\s+)?(?:node|tsx)\b[^;&|]*--test\b|(?:npx\s+)?(?:node|tsx)\b[^;&|]*(?:scripts\/run-node-tests\.ts|desktop\/scripts\/run-tests\.ts)\b|(?:npx\s+)?(?:tsc|vitest|jest|pytest|eslint|mocha|ava)\b|cargo\s+(?:test|check)\b|go\s+(?:test|vet|build)\b|dotnet\s+(?:test|build|run)\b|(?:\.\/)?(?:mvn|mvnw|gradle|gradlew)\b(?=[^;&|]*\s(?:test|verify|build|check|assemble|compile|package|install)(?=\s|$)))/

/** 非 JS 生态 runner（.NET / Maven / Gradle）的验证调用。
 *  dotnet 的目标子命令紧跟可执行名（flag 在后）：`dotnet test tests/X.csproj`。
 *  Maven/Gradle 是「阶段 / 任务序列」（`mvn clean test`、`./gradlew clean build`）——目标词
 *  可在任意位置，前面排生命周期阶段（clean）或全局选项（-q / -B）都不改变语义，故用前瞻匹配。
 *  项目路径等定位参数同样不改「全量」语义；只有明确的选择/过滤标志才表示只跑了子集（→ unknown）。 */
const NON_JS_VERIFICATION_RUNNER = /^(?:dotnet (?:test|build|run)(?:\s|$)|(?:mvn|mvnw|gradle|gradlew)\b(?=[^;&|]*\s(?:test|verify|build|check|assemble|compile|package|install)(?=\s|$)))/
const NON_JS_SELECTION_FLAG = /(?:^|\s)(?:--filter|--testcasefilter|--tests|--test-case-filter|-Dtest=)/i

function containsVerificationInvocation(command: string): boolean {
  return VERIFICATION_SEGMENT.test(command.replace(/'[^']*'|"[^"]*"/g, ' '))
}

/** This parser only classifies an already executed command; it never executes it.
 *
 *  Returns null when the command is **not a verification invocation at all**
 *  (pure queries like `wc -l foo.test.ts`, `ls scripts/build-*.sh`,
 *  `gh run list --workflow=build-*.yml`). 以前记账入口用一条宽松文本正则
 *  （命令里出现 test/build/check 字样即记），于是纯查询也被记进 verification
 * 台账（blocked 一片），反过来污染交付报表（2026-10-06 实测：一轮 21 条
 * blocked 里大半是纯查询）。 */
function classifyBashVerification(command: string): Pick<VerificationMetadata, 'scope' | 'targetFiles' | 'kind'> | null {
  command = unwrapVerification(command, process.cwd())?.command ?? command
  const tokens = verificationArgv(command)
  if (!tokens) {
    // 复合 shell 不能充当证据，但「段首有受支持运行器」仍是验证意图 →
    // 保留 unknown（上层标 blocked 并给写法指引）；纯查询则完全不进台账。
    return containsVerificationInvocation(command) ? { scope: 'unknown' } : null
  }
  const invocationInfo = classifyVerificationCommand(command)
  if (invocationInfo.nodeTest || invocationInfo.batchRunner) {
    return { kind: 'test', scope: invocationInfo.filtered ? 'unknown' : invocationInfo.targets.length ? 'targeted' : 'full', ...(invocationInfo.targets.length ? { targetFiles: invocationInfo.targets } : {}) }
  }
  if (tokens.some(arg => arg === '--version' || arg === '--help')) return null
  if (tokens[0] === 'rtk') { tokens.shift(); if (String(tokens[0]) === 'proxy') tokens.shift() }
  if (tokens[0] === 'rtk') return { scope: 'unknown' }
  const executable = basename((tokens[0] ?? '').replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/i, '')
  const args = tokens.slice(1)
  const invocation = [executable, ...args].join(' ')
  const kind: VerificationMetadata['kind'] =
    /^(?:(?:npm|pnpm|yarn) (?:test|run test)|(?:npx )?(?:(?:node|tsx) --test|vitest(?: run)?|jest|pytest)|cargo test|go test|dotnet test|(?:mvn|mvnw|gradle|gradlew)\b(?=[^;&|]*\s(?:test|verify)(?=\s|$)))(?:\s|$)/.test(invocation) ? 'test'
    : /^(?:(?:npm|pnpm|yarn) run typecheck|(?:npx )?tsc)(?:\s|$)/.test(invocation) ? 'typecheck'
    : /^(?:(?:npm|pnpm|yarn) run lint|(?:npx )?eslint)(?:\s|$)/.test(invocation) ? 'lint'
    : /^(?:(?:npm|pnpm|yarn) run build|go build|dotnet (?:build|run)|(?:mvn|mvnw|gradle|gradlew)\b(?=[^;&|]*\s(?:build|assemble|compile|package|install)(?=\s|$)))(?:\s|$)/.test(invocation) ? 'build'
    : /^(?:cargo check|go vet|(?:mvn|mvnw|gradle|gradlew)\b(?=[^;&|]*\scheck(?=\s|$)))(?:\s|$)/.test(invocation) ? 'check' : undefined
  // A name/tag selector proves only a subset within each selected file.
  if (kind === 'test' && /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--grep|-t|-k|-m)(?:[=\s]|$)/.test(invocation)) {
    return { scope: 'unknown', kind }
  }
  const targetFiles = [...new Set(args.filter(arg => !arg.startsWith('-')
    && /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|sh)$/.test(arg)))]
  // 只有识别出受支持运行器，路径参数才算「目标文件」——否则 `wc -l foo.test.ts`
  // 也会被当成 targeted 验证（旧行为，台账污染的来源之一）。
  if (kind && targetFiles.length > 0) return { scope: 'targeted', targetFiles, kind }

  // Full describes an unfiltered invocation, not proof of every suite's
  // coverage. Unknown scripts and selectors retain unknown scope.
  if (/^(?:npm|pnpm|yarn) (?:test|run test)$/.test(invocation)
    || /^(?:node|tsx) --test$/.test(invocation)
    || /^(?:npx )?(?:vitest(?: run)?|jest|pytest)$/.test(invocation)
    || /^(?:cargo test|go test \.\/\.\.\.)$/.test(invocation)) return { scope: 'full', kind: 'test' }
  if (/^(?:npm|pnpm|yarn) run typecheck$/.test(invocation)
    || /^(?:npx )?tsc(?: --noEmit)?$/.test(invocation)) return { scope: 'full', kind: 'typecheck' }
  if (/^(?:npm|pnpm|yarn) run lint$/.test(invocation)) return { scope: 'full', kind: 'lint' }
  if (/^(?:npm|pnpm|yarn) run build$/.test(invocation)
    || /^go build \.\/\.\.\.$/.test(invocation)) return { scope: 'full', kind: 'build' }
  if (/^(?:cargo check|go vet \.\/\.\.\.)$/.test(invocation)) return { scope: 'full', kind: 'check' }
  // 非 JS 生态 runner：项目路径等定位参数不改变「全量」语义；带选择/过滤标志才是子集。
  if (NON_JS_VERIFICATION_RUNNER.test(invocation)) {
    return NON_JS_SELECTION_FLAG.test(invocation) ? { scope: 'unknown', kind } : { scope: 'full', kind }
  }
  // 仍未识别出 kind：区分「验证意图但归因不了」与「根本不是验证」。
  // 前者（`custom node --test a.test.ts`、`node --test --unknown`）要留在台账里
  // 标 blocked 并给写法指引；后者（wc / ls / grep / sed / gh run list）不得进台账。
  const hasTestFlag = args.some(arg => arg === '--test' || arg.startsWith('--test='))
  return hasTestFlag || containsVerificationInvocation(command) ? { scope: 'unknown' } : null
}

/** 该命令是否是验证调用——**记账入口必须用它过滤**，纯查询不进 verification 台账。 */
export function isVerificationCommand(command: string): boolean {
  return classifyBashVerification(command) !== null
}

/** 复合命令里那条可归因的验证段——用于 blocked 时给出**可复制**的单条命令。
 *
 *  动机：`cd repo && npm test | tail -5` 是最自然的写法，但归因器无法给它逐文件
 *  完成证明，旧反馈只说「请使用工具 cwd 和独立命令」——用户不知道该写成什么样。
 *  这里把内层验证段切出来（引号内容先掩码以免切坏带空格的路径），去掉重定向与
 *  `cd` 前缀后返回，让反馈变成可粘贴的命令。已经是单条可归因形态 → null（不回显自己）。 */
export function suggestSingleCommand(command: string): string | null {
  const trimmed = command.trim()
  // 单条且能被 argv 解析 = 已经是好形态，无需建议。
  if (verificationArgv(trimmed) !== null && isVerificationCommand(trimmed)) return null
  const holes: string[] = []
  const masked = trimmed.replace(/'[^']*'|"[^"]*"/g, m => {
    holes.push(m)
    return `\u0000${holes.length - 1}\u0000`
  })
  for (const raw of masked.split(/&&|\|\||[;|]/)) {
    const seg = raw
      .replace(/\d*>>?\s*[^\s&|;]+/g, ' ')   // > out / 2> err
      .replace(/\d*>&\d+/g, ' ')             // 2>&1
      .replace(/^\s*cd\s+[^\s&|;]+\s*/, '')  // cd 前缀（单条命令请用工具的 cwd 参数）
      .trim()
    if (!seg) continue
    const restored = seg.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => holes[Number(i)] ?? '')
    if (isVerificationCommand(restored)) return restored
  }
  return null
}

/** 兼容入口：始终给出一个 scope；不是验证命令时退化为 unknown（供只关心
 *  scope/targetFiles 的消费方使用）。判断「要不要记账」请用 isVerificationCommand。 */
export function inferBashVerificationScope(command: string): Pick<VerificationMetadata, 'scope' | 'targetFiles' | 'kind'> {
  return classifyBashVerification(command) ?? { scope: 'unknown' }
}

/** blocked 时的可操作反馈：说清为什么无法归因 + 给出可复制的单条命令。 */
function blockedGuidance(command: string): string {
  const reason = classifyVerificationCommand(command).reason
  const suggestion = suggestSingleCommand(command)
  if (!suggestion) return reason ?? '缺少完整逐文件完成证明；请用支持的运行器重新验证。'
  return `${reason ?? '这条命令无法归因为验证。'}\n可复制的单条命令：${suggestion}`
}

function count(output: string, pattern: RegExp): number {
  const match = output.match(pattern)
  return match ? Number.parseInt(match.slice(1).find(value => value !== undefined) ?? '0', 10) : 0
}

export function buildBashVerification(
  command: string,
  result: ToolResult | undefined,
  outcome: { content: string; isError: boolean; errorClass?: string },
): VerificationMetadata {
  const output = outcome.content
  let passed = count(output, /(?:ℹ|#)\s+pass\s+(\d+)|✅\s+(\d+)\s+passed|Tests?\s+(\d+)\s+passed/i)
  let failed = count(output, /(?:ℹ|#)\s+fail\s+(\d+)|❌\s+(\d+)\s+failed|Tests?\s+(\d+)\s+failed/i)
  let skipped = count(output, /(?:ℹ|#)\s+(?:skip|skipped)\s+(\d+)/i)
  const exitCode = typeof result?.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : undefined
  const errorClass = result?.errorClass ?? (outcome.isError ? outcome.errorClass : undefined)
  const timedOut = errorClass === 'timeout' || /timed out after \d+s/i.test(output)
  const counts: TestCounts = { passed, failed, skipped, exitCode: exitCode ?? -1, failures: [] }
  applyBatchCounts(output, counts)
  Object.assign(counts, completionFacts(result?.verification?.coverage))
  ;({ passed, failed, skipped } = counts)
  const scope = result?.verification?.coverage
    ? { kind: 'test' as const, scope: result.verification.scope, targetFiles: result.verification.targetFiles ?? inferBashVerificationScope(command).targetFiles }
    : inferBashVerificationScope(command)
  const status = outcome.isError || result?.isError || timedOut || failed > 0 || (exitCode !== undefined && exitCode !== 0)
    ? 'failed' : exitCode === 0 && scope.scope !== 'unknown' ? 'passed' : 'blocked'
  const failureKind = timedOut ? 'timeout'
    : status === 'failed' && (errorClass === 'environment' || errorClass === 'exec-failure') ? 'tool_invocation_failure'
    : status === 'failed' && exitCode !== undefined && result?.isError === false ? 'test_failure'
    : undefined
  return {
    command, status, ...scope, passed, failed, skipped, countsReliable: counts.countsReliable,
    ...(result?.verification?.coverage ? { coverage: result.verification.coverage } : {}),
    ...(status === 'blocked' || scope.kind === 'test' && !result?.verification?.coverage?.complete ? { userGuidance: blockedGuidance(command) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...completionFacts(result?.verification?.coverage),
    ...(result?.verification?.timestamp ? { timestamp: result.verification.timestamp, durationMs: result.verification.durationMs } : {}),
  }
}
