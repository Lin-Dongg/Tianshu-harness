import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * issue #356 防回归不变量：deliver_task 的每个 isError 返回都必须带 errorKind。
 *
 * 背景：tool-pipeline 的 classify 闭包是「结构优先、文本兜底」——
 * resolveErrorKind(rawToolResult) ?? classifyFailure(content)。deliver_task 的
 * 返回文本必经 L537 回显 verify 命令（如 "timeout 300 dotnet build"），
 * 一旦某个分支漏标 errorKind，文本正则就会按 timeout 分类并触发自动重试
 * （lock 分支重试确定性全败；commit 分支重试会重新进入 commit）。
 *
 * 判据：源码中每个 `isError: true` 出现处的 ±2 行窗口内必须含 `errorKind`
 * （窗口容纳未来可能的多行返回对象形态）。__tests__ 不受行数棘轮守备
 * （structure-gate.ts isGuardedSourcePath 豁免），本文件无预算成本。
 */
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'deliver-task.ts')

test('deliver-task.ts 的每个 isError:true 返回必须带 errorKind（issue #356 防回归）', () => {
  const lines = readFileSync(SOURCE, 'utf-8').split('\n')
  const offenders: string[] = []

  lines.forEach((line, i) => {
    if (!/isError:\s*true/.test(line)) return
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n')
    if (!/errorKind/.test(window)) {
      offenders.push(`L${i + 1}: ${line.trim()}`)
    }
  })

  assert.deepEqual(
    offenders,
    [],
    `isError 返回缺 errorKind，会被 failure-classifier 文本正则接管（见 issue #356）:\n${offenders.join('\n')}`,
  )
})

test('锚点自检：deliver-task.ts 确实存在 isError 返回（防止正则失配导致空扫描假绿）', () => {
  const source = readFileSync(SOURCE, 'utf-8')
  const count = source.split('\n').filter(l => /isError:\s*true/.test(l)).length
  assert.ok(count >= 15, `扫描到的 isError: true 数量 ${count} 异常偏少——正则或文件结构已漂移，本不变量测试需同步更新`)
})
