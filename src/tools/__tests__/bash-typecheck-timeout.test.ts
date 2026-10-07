/**
 * bash 工具对「全量类型检查」形态的超时契约。
 *
 * ## 为什么需要这份契约
 * bash 工具会把 typecheck 形态的命令送进跨进程共享闸门
 * （`executeBashMaybeSerialized` → `runAdhocTypecheckShared`）。闸门的所有会话与
 * 隔离 worktree **共用一把锁**（worktree 的 node_modules 是指向主仓的 symlink，
 * 缓存目录物理上是同一把），持锁者满载时等待预算是 10 分钟
 * （`typecheck-cache.ts` 的 `DEFAULT_WAIT_BUDGET_MS = STALE_LOCK_MS`）。
 *
 * 而工具管线给的默认预算是 `DEFAULT_TOOL_TIMEOUT_MS = 120_000`
 * （`src/agent/tool-pipeline.ts`）。**工具声明的预算小于它自己选用的闸门预算**，
 * 于是高负载下必然 `[tool-timeout] bash timed out after 120s`——不是命令慢，
 * 是这两个数字从来没对齐过。2026-09-14 在并行审查 worker 里实测复现。
 *
 * ## 2026-09-25：两侧都得对齐，只修一侧不生效
 *
 * 上面那段修的是**声明侧**（`BASH_TOOL.timeoutMs`）。执行侧当时仍按
 * `params.input.timeout` 设 SIGTERM 定时器（`executeBashOnce`），于是模型传
 * 420000 时——实测 21 次 typecheck 调用里 8 次这么传——比闸门预算早 6 分钟落刀：
 * exit=-1，且 `| tail` 会把已有输出一并吞掉（lines=1、零结果）→ ledger 记
 * 「验证超时」→ `deliver_task` 拒绝提交（isError）→ turn-harness 再重试两轮。
 * 交付门 31 次调用 20 次 error，其中 RED 为 0：没有一次是真失败。
 * 修法是 `resolveBashTimeout`（只抬不压）。下面的执行侧用例与声明侧用例
 * 必须一起通过，任一单侧退化都等于这个 bug 复现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASH_TOOL } from '../bash.js'
import { isTypecheckCommand, isTestRunnerCommand, resolveCallerTimeoutBudget, resolveWatchdogTimeout, TEST_RUNNER_CALLER_BUDGET_MS, TYPECHECK_CALLER_BUDGET_MS, TYPECHECK_WATCHDOG_MARGIN_MS, STALE_LOCK_MS } from '../../lsp/typecheck-cache.js'
import type { ToolCallParams } from '../types.js'

/** 闸门等待上限——直接取真源（2026-10-08 起 STALE_LOCK_MS = 5 分钟；此前硬编码
 *  10 分钟，阈值调整时会漏改导致覆盖断言假红/假绿）。 */
const GATE_WAIT_BUDGET_MS = STALE_LOCK_MS

/** bash 工具的默认预算固定传 120s——本文件只关心 typecheck 那一支的抬升。 */
const budgetFor = (command: string, requested: number): number =>
  resolveCallerTimeoutBudget(command, requested, 120_000)

function timeoutFor(command: string): number {
  return BASH_TOOL.timeoutMs?.({ input: { command } } as unknown as ToolCallParams) ?? 0
}

/** 声明侧（外层看门狗）预算——可带模型显式传的 timeout，验证「只抬不压」在两侧一致。 */
function declaredFor(command: string, requested?: number): number {
  const input = requested === undefined ? { command } : { command, timeout: requested }
  return BASH_TOOL.timeoutMs?.({ input } as unknown as ToolCallParams) ?? 0
}

test('typecheck 形态拿到的工具级预算必须覆盖闸门等待上限', () => {
  // 这些形态会被 isTypecheckCommand 判为 YES 并因此走闸门——预算小一毫秒，
  // 高负载下就是必然超时。
  const commands = [
    'npm run typecheck',
    'npm run typecheck 2>&1 | tail -25',
    'npx tsc --noEmit',
    'tsc --noEmit',
    'npm exec -- tsc --noEmit',
  ]
  for (const cmd of commands) {
    assert.ok(isTypecheckCommand(cmd), `前提：${cmd} 应被判为 typecheck 形态`)
    assert.ok(
      timeoutFor(cmd) >= GATE_WAIT_BUDGET_MS,
      `${cmd} 的工具预算 ${timeoutFor(cmd)}ms 小于闸门等待上限 ${GATE_WAIT_BUDGET_MS}ms——会必然超时`,
    )
  }
})

test('普通命令保持默认预算；测试运行拿到有界专用预算（2026-10-05）', () => {
  // `npm test` 从此表移出：全量约 52s，只拿 120s 默认预算时，多会话共享工作区的
  // CPU 竞争下必被超时杀掉 → 结果被超时占位替换 → 无 exitCode、无输出计数 →
  // verification 恒 blocked → 交付门禁的 full-scope 覆盖义务不可满足。
  // 它拿到的是**有界**的 TEST_RUNNER_CALLER_BUDGET_MS（5 分钟），不是 typecheck 的
  // 13 分钟闸门预算——「不因修复被放大」这条原则仍成立，只是边界从「只有 typecheck」
  // 收窄为「typecheck + 测试运行，且测试那一档显著更小」。
  for (const cmd of ['ls -la', 'npm run build', 'git status']) {
    assert.equal(timeoutFor(cmd), 120_000, `${cmd} 不该拿到闸门长预算`)
  }
  assert.equal(
    timeoutFor('npm test'),
    TEST_RUNNER_CALLER_BUDGET_MS + TYPECHECK_WATCHDOG_MARGIN_MS,
    '测试运行拿有界专用预算（timeoutFor 读的是声明侧 = 执行侧 + 看门狗余量）',
  )
  assert.ok(
    TEST_RUNNER_CALLER_BUDGET_MS < TYPECHECK_CALLER_BUDGET_MS,
    '测试预算必须显著小于 typecheck 的闸门预算（后者长是因为要等跨进程共享锁）',
  )
})

test('tsc --watch 是长跑形态，不算 typecheck 收口对象', () => {
  // isTypecheckCommand 的注释声明「--watch 等长跑形态不匹配（走后台 job 通道）」，
  // 但 2026-09-14 探针实测它匹配。watch 进程永不退出：送进闸门等于占着锁不放，
  // 真正的 typecheck 反而被它挡住；前台跑还会等到工具超时。
  assert.equal(isTypecheckCommand('tsc --noEmit --watch'), false, 'watch 形态不该进闸门')
  assert.equal(timeoutFor('tsc --noEmit --watch'), 120_000, 'watch 形态保持默认预算')
})

// ─── 执行侧：模型传的小预算不能突破闸门等待（2026-09-25 补齐） ──────────────

test('执行侧预算被抬到闸门上限：模型传的 420s 不再提前落刀', () => {
  // 生产事故形态：复合命令 + 管道（`| tail` 超时时会把已有输出一并吞掉）。
  const incident = 'cd /Users/banxia/app/tianshu-3.15 && npm run typecheck 2>&1 | tail -40'
  assert.equal(budgetFor(incident, 420_000), TYPECHECK_CALLER_BUDGET_MS)
  assert.equal(budgetFor('npm run typecheck', 60_000), TYPECHECK_CALLER_BUDGET_MS)
  assert.equal(budgetFor('npx tsc --noEmit', 5_000), TYPECHECK_CALLER_BUDGET_MS)
})

test('声明侧与执行侧同源：两侧都覆盖闸门等待，且都不压低更大的调用方预算', () => {
  const incident = 'npm run typecheck 2>&1 | tail -40'
  const declared = BASH_TOOL.timeoutMs?.({ input: { command: incident } } as unknown as ToolCallParams) ?? 0
  assert.ok(declared >= GATE_WAIT_BUDGET_MS, '声明侧须覆盖闸门等待（2026-09-14 的修复）')
  assert.ok(budgetFor(incident, 1) >= GATE_WAIT_BUDGET_MS, '执行侧须覆盖闸门等待（2026-09-25 的修复）')
  assert.equal(budgetFor(incident, 900_000), 900_000, '调用方给的更大预算不被压低')
})

test('执行侧不误伤普通命令：只有闸门形态（typecheck / 测试运行）才抬升', () => {
  // `npm test` 从「普通命令」移出（2026-10-05）：它是闸门形态，拿有界专用预算。
  // 普通命令的代表改用 npm run build（非测试、非 typecheck）。
  assert.equal(budgetFor('npm test', 5_000), TEST_RUNNER_CALLER_BUDGET_MS, '测试运行属闸门形态，抬到专用预算')
  assert.equal(budgetFor('npm run build', 5_000), 5_000, '非闸门形态原样用传入预算')
  assert.equal(budgetFor('ls -la', NaN), 120_000, '非正数/NaN 走默认预算')
  assert.equal(budgetFor('tsc --noEmit --watch', 5_000), 5_000, 'watch 形态不进闸门，也不该被抬升')
})

test('RIVET_TYPECHECK_SHARE=0 逃生口：闸门关闭时执行侧不抬升', () => {
  const prev = process.env.RIVET_TYPECHECK_SHARE
  process.env.RIVET_TYPECHECK_SHARE = '0'
  try {
    assert.equal(budgetFor('npm run typecheck', 60_000), 60_000)
  } finally {
    if (prev === undefined) delete process.env.RIVET_TYPECHECK_SHARE
    else process.env.RIVET_TYPECHECK_SHARE = prev
  }
})

// ─── 两侧的相对关系：声明侧必须严格大于执行侧（2026-09-25 二修） ─────────────

test('声明侧必须严格大于执行侧——否则外层看门狗先落刀，专用文案到不了模型', () => {
  // 机制：外层看门狗在 tool-pipeline 读 toolDef.timeoutMs 武装（execute 之前），
  // 内层 SIGTERM 定时器要等子进程起来才武装。两侧预算**相等**时外层必先 reject，
  // 于是 bash.ts:765 的 TYPECHECK_TIMEOUT_HINT（专门教模型改走 run_in_background
  // 的那段引导）永远投递不出去，模型只拿到通用超时文案——4a6380d5c 想改善的场景
  // 没生效。余量给了内层杀进程 + 整理输出的时间。
  const incident = 'npm run typecheck 2>&1 | tail -40'
  assert.ok(
    declaredFor(incident) > budgetFor(incident, NaN),
    `声明侧 ${declaredFor(incident)}ms 必须 > 执行侧 ${budgetFor(incident, NaN)}ms`,
  )
  // 模型显式传更大预算时两侧都要跟随，且声明侧仍保持严格更大（否则大预算下外层又会先落刀）。
  for (const requested of [60_000, 420_000, 900_000]) {
    const declared = declaredFor(incident, requested)
    const exec = budgetFor(incident, requested)
    assert.ok(
      declared > exec,
      `调用方传 ${requested}ms 时：声明侧 ${declared}ms 仍须 > 执行侧 ${exec}ms`,
    )
  }
})

test('非 typecheck 形态的声明侧预算不变（仍是工具默认 120s）', () => {
  for (const cmd of ['ls -la', 'npm run build', 'git status']) {
    assert.equal(declaredFor(cmd), 120_000, `${cmd} 不该被这次修复放大`)
    assert.equal(declaredFor(cmd, 300_000), 120_000, `${cmd} 的模型预算不参与声明侧抬升`)
  }
})

test('闸门关闭（RIVET_TYPECHECK_SHARE=0）时声明侧仍严格大于执行侧', () => {
  const prev = process.env.RIVET_TYPECHECK_SHARE
  process.env.RIVET_TYPECHECK_SHARE = '0'
  try {
    const cmd = 'npm run typecheck'
    assert.ok(
      declaredFor(cmd, 60_000) > budgetFor(cmd, 60_000),
      '闸门关闭时执行侧不抬升，声明侧也必须跟着退回「执行侧 + 余量」，不能反过来先落刀',
    )
  } finally {
    if (prev === undefined) delete process.env.RIVET_TYPECHECK_SHARE
    else process.env.RIVET_TYPECHECK_SHARE = prev
  }
})

// ── 测试运行形态：与 typecheck 同等的闸门预算（2026-10-05 清红批） ──────────
//
// 取证：`npm test` 全量约 52s，只拿 120s 默认预算时，在多会话共享工作区的 CPU
// 竞争下必然撞超时被杀 → 结果被超时占位替换 → 无 exitCode、无计数 →
// verification 恒 blocked → 交付门禁的 full-scope 覆盖义务永远无法满足
// （核心改动结构性无法提交）。实测锚点：`npm test` 记录 `scope:full, kind:test`
// 但无 `exitCode` 字段且 `passed:0`，而同一条 `npm run typecheck`（13.7s 跑得完）
// 带 `exitCode:2`。
//
// 三条用例分别钉：识别面（含 watch/构造误判）、预算抬升、看门狗严格大于执行侧。

test('isTestRunnerCommand 认得全量测试形态；watch 与普通构造不误判', () => {
  for (const cmd of [
    'npm test',
    'npm run test',
    'npm run test:unit',
    'pnpm test',
    'npx tsx --test',
    'tsx --test src/agent/__tests__/loop.test.ts',
    'node --test',
    'npx vitest run',
    'jest',
    'pytest',
  ]) {
    assert.ok(isTestRunnerCommand(cmd), `应判为测试运行形态：${cmd}`)
  }
  for (const cmd of [
    'npm test -- --watch',
    'npx vitest --watch',
    'npm run build',
    'npx tsc --noEmit',
    'ls src/test-fixtures',
  ]) {
    assert.equal(isTestRunnerCommand(cmd), false, `不该判为测试运行形态：${cmd}`)
  }
})

test('测试运行形态走有界专用预算：抬升但显著小于 typecheck，且只抬不压', () => {
  assert.equal(
    resolveCallerTimeoutBudget('npm test', 0, 120_000),
    TEST_RUNNER_CALLER_BUDGET_MS,
    'npm test 必须拿到专用预算，否则 52s 的全量测试在竞争下必被 120s 默认预算杀掉',
  )
  assert.ok(
    TEST_RUNNER_CALLER_BUDGET_MS < TYPECHECK_CALLER_BUDGET_MS,
    '测试预算有界——不套用 typecheck 的 13 分钟（那档是为等跨进程共享锁而设）',
  )
  const explicit = TEST_RUNNER_CALLER_BUDGET_MS + 60_000
  assert.equal(resolveCallerTimeoutBudget('npm test', explicit, 120_000), explicit, '调用方给更大值时不压')
  assert.equal(resolveCallerTimeoutBudget('npm run build', 0, 120_000), 120_000, '非闸门形态不参与抬升')
})

test('测试运行形态的看门狗预算同样抬升且严格大于执行侧', () => {
  const exec = resolveCallerTimeoutBudget('npm test', 0, 120_000)
  const watch = resolveWatchdogTimeout('npm test', 0, 120_000)
  assert.ok(watch > exec, '声明侧必须严格大于执行侧，否则专用超时文案不可达')
  assert.equal(resolveWatchdogTimeout('npm run build', 0, 120_000), 120_000, '非闸门形态原样返回')
})

test('跨链契约：full 形态两链对齐，派生形态刻意分叉（预算多认、验证记 unknown）', async () => {
  const { inferBashVerificationScope } = await import('../../agent/bash-verification.js')
  // full 形态对齐：预算抬升 ↔ 验证记 full+test（只抬预算换不来 passed 记录 = 空转）。
  for (const cmd of ['npm test', 'node --test', 'npx vitest run']) {
    assert.ok(isTestRunnerCommand(cmd), `预算链应认：${cmd}`)
    assert.deepEqual(
      inferBashVerificationScope(cmd),
      { scope: 'full', kind: 'test' },
      `验证链应记 full+test：${cmd}`,
    )
  }
  // 派生形态刻意不同：子集也可能跑得久（预算照抬），但子集不满足 full-scope
  // 覆盖义务（验证记 unknown 而非 full）——语义差异，不是漂移。
  assert.ok(isTestRunnerCommand('npm run test:unit'), '预算链认派生形态')
  assert.notEqual(inferBashVerificationScope('npm run test:unit').scope, 'full', '派生形态不得记 full')
})
