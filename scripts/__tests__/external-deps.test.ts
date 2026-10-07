import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORCE_BUNDLED, RUNTIME_BUNDLED, SCAN_ALLOWED, verifyConsistency } from '../external-deps.js'

test('RUNTIME_BUNDLED ⊆ SCAN_ALLOWED — 随包分发必在扫描允许集内', () => {
  const allowed = new Set(SCAN_ALLOWED)
  const missing = RUNTIME_BUNDLED.filter((p) => !allowed.has(p))
  assert.deepEqual(missing, [], `RUNTIME_BUNDLED 中 ${missing.join(', ')} 未列入 SCAN_ALLOWED`)
})

test('FORCE_BUNDLED ∩ RUNTIME_BUNDLED = ∅ — 内联与随包分发互斥', () => {
  const overlap = FORCE_BUNDLED.filter((n) => RUNTIME_BUNDLED.includes(n))
  assert.deepEqual(overlap, [], `同一包不能既内联又随包分发：${overlap.join(', ')}`)
})

test('每个 package.json runtime 依赖都已归类（内联 / 随包分发 / 扫描允许）', () => {
  // 守卫本不变量：漏归类的纯 JS 依赖会以裸导入留在 dist，assert-runtime-imports
  // 在打包链末步挂红（zod-to-json-schema 2026-09-18、yaml 4940f9c94 两次复发）。
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'))
  const classified = new Set([...FORCE_BUNDLED, ...RUNTIME_BUNDLED, ...SCAN_ALLOWED])
  const unclassified = Object.keys(pkg.dependencies ?? {}).filter((d) => !classified.has(d))
  assert.deepEqual(
    unclassified,
    [],
    `未归类依赖会留成裸导入并让 assert-runtime-imports 红：${unclassified.join(', ')} — ` +
      `加进 scripts/external-deps.js 的 FORCE_BUNDLED（纯 JS 内联）或 RUNTIME_BUNDLED（随包分发）`,
  )
})

test('三清单无重复条目', () => {
  const dup = (list) => {
    const seen = new Set()
    return list.filter((item) => seen.has(item) || (seen.add(item), false))
  }
  assert.deepEqual(dup(RUNTIME_BUNDLED), [], 'RUNTIME_BUNDLED 重复')
  assert.deepEqual(dup(SCAN_ALLOWED), [], 'SCAN_ALLOWED 重复')
  assert.deepEqual(dup(FORCE_BUNDLED), [], 'FORCE_BUNDLED 重复')
})

test('verifyConsistency 通过合法清单', () => {
  assert.doesNotThrow(() => verifyConsistency())
})

test('verifyConsistency 拒绝 RUNTIME_BUNDLED 漏列进 SCAN_ALLOWED', () => {
  assert.throws(
    () => verifyConsistency({ runtimeBundled: ['leaked-pkg'], scanAllowed: [] }),
    /RUNTIME_BUNDLED ⊆ SCAN_ALLOWED/,
  )
})

test('verifyConsistency 拒绝重复条目', () => {
  assert.throws(
    () => verifyConsistency({ runtimeBundled: ['a', 'a'], scanAllowed: ['a'] }),
    /重复条目 'a'/,
  )
})

test('verifyConsistency 拒绝 FORCE_BUNDLED 与 RUNTIME_BUNDLED 重叠', () => {
  assert.throws(
    () =>
      verifyConsistency({
        runtimeBundled: ['dup-pkg'],
        scanAllowed: ['dup-pkg'],
        forceBundled: ['dup-pkg'],
      }),
    /FORCE_BUNDLED ∩ RUNTIME_BUNDLED/,
  )
})
