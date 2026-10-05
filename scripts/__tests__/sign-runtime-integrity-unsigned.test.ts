/**
 * sign-runtime-integrity：RIVET_ALLOW_UNSIGNED_RUNTIME=1 的本地开发路径必须真能走完。
 *
 * 缺陷形态（2026-10-01 本地打包实测）：warn「本次构建不含完整性清单」之后没有
 * return/exit，控制流继续落到 gen-integrity-manifest.ts——它缺私钥即抛错，
 * beforeBuildCommand 整条失败。文档化的本地构建路径实际打不出包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const sourceUrl = new URL('../../desktop/scripts/sign-runtime-integrity.js', import.meta.url)

test('无私钥 + RIVET_ALLOW_UNSIGNED_RUNTIME=1：warn 之后直接 exit 0，不调 gen-integrity-manifest', {
  skip: !existsSync(sourceUrl) && 'CLI 仓库不包含桌面签名脚本',
}, () => {
  const src = readFileSync(sourceUrl, 'utf8')
  const warnIdx = src.indexOf('RIVET_ALLOW_UNSIGNED_RUNTIME=1：本次构建')
  assert.ok(warnIdx > 0, '应有未签名警告块')
  const execIdx = src.indexOf('gen-integrity-manifest.ts', warnIdx)
  assert.ok(execIdx > warnIdx, '应能定位 gen-integrity-manifest 调用点')
  const between = src.slice(warnIdx, execIdx)
  assert.match(
    between,
    /process\.exit\(0\)/,
    '警告块与清单生成之间必须有 process.exit(0)——否则「跳过」只是说说，实际仍然执行签名',
  )
})
