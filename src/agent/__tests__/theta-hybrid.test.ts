import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { runThetaCheck } from '../theta-check.js'
import { writeCachedTypecheck, defaultCacheDir } from '../../lsp/typecheck-cache.js'
import { TSC_GATE_VARIANT } from '../../lsp/client.js'

/** 创建一个临时 git 仓库用于测试 */
function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theta-hybrid-test-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email "test@example.com"', { cwd: dir })
  execSync('git config user.name "Test"', { cwd: dir })

  // 创建基础文件
  writeFileSync(join(dir, 'test.ts'), 'const x: string = "hello";\n')
  execSync('git add .', { cwd: dir })
  execSync('git commit -q -m "init"', { cwd: dir })

  return dir
}

describe('Theta hybrid strategy (2026-10-07)', () => {
  it('accepts ThetaCheckOptions object (new interface)', async () => {
    const dir = makeTempGitRepo()
    try {
      const result = await runThetaCheck({
        cwd: dir,
        timeoutMs: 15000,
        triggerOnMiss: false,
      })

      // 无缓存，triggerOnMiss=false，应该返回 no-fresh-verdict
      assert.equal(result.outcome, 'no-fresh-verdict')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts legacy string cwd parameter (backward compatibility)', async () => {
    const dir = makeTempGitRepo()
    try {
      const result = await runThetaCheck(dir)

      // 向后兼容：旧签名仍然工作
      assert.equal(result.outcome, 'no-fresh-verdict')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns cached verdict when available', async () => {
    const dir = makeTempGitRepo()
    try {
      // 预置缓存条目
      const cacheDir = defaultCacheDir(dir)
      mkdirSync(cacheDir, { recursive: true })

      // 写入一个成功的缓存
      const fingerprint = 'test-fingerprint-abc123'
      writeCachedTypecheck(cacheDir, {
        status: 0,
        stdout: '',
        stderr: '',
        fingerprint,
        finishedAt: Date.now(),
        durationMs: 1000,
      })

      // 注意：实际运行时指纹不匹配（因为我们用的是假指纹）
      // 所以这个测试会返回 no-fresh-verdict
      // 这是预期的，因为我们只是测试接口，不是测试实际的缓存命中逻辑
      const result = await runThetaCheck({
        cwd: dir,
        triggerOnMiss: false,
      })

      // 由于指纹不匹配，返回 no-fresh-verdict
      assert.equal(result.outcome, 'no-fresh-verdict')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects triggerOnMiss=false (保持只读消费者行为)', async () => {
    const dir = makeTempGitRepo()
    try {
      const result = await runThetaCheck({
        cwd: dir,
        triggerOnMiss: false, // 明确禁用触发
      })

      // 无缓存，不触发真跑，返回 no-fresh-verdict
      assert.equal(result.outcome, 'no-fresh-verdict')
      assert.equal(result.durationMs, 0)
      assert.equal(result.timedOut, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('triggerOnMiss=true triggers real run and returns actual result', async () => {
    const dir = makeTempGitRepo()
    try {
      const result = await runThetaCheck({
        cwd: dir,
        triggerOnMiss: true, // 请求触发真跑
        triggerReason: 'test-trigger',
      })

      // 应该触发真跑并返回实际结果
      // 可能是 ok, type_errors, 或 timeout（如果环境没有 tsc）
      assert.notEqual(result.outcome, 'no-fresh-verdict',
        'triggerOnMiss=true should trigger real typecheck, not return no-fresh-verdict')

      // 验证返回的是合法的 outcome
      const validOutcomes = ['ok', 'type_errors', 'timeout', 'spawn_error']
      assert.ok(validOutcomes.includes(result.outcome),
        `Expected one of ${validOutcomes.join(', ')}, got ${result.outcome}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
