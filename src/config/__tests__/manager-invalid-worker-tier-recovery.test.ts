import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'

/**
 * 非法 worker tier 值的加载期恢复（2026-10-06）。
 *
 * 用户报告：某次写入把 profile 名 'cheap-flash' 填进了 workers.patcherTier。
 * 该值不在枚举内 → configSchema 校验失败 → loadConfig 是 fail-loud（绝不静默
 * 回退）→ **一个字段写错就让整个应用起不来**。
 *
 * 这两个字段是「值域封闭的开关」：非法值不代表任何可用意图，回落 schema 默认
 * 安全且无歧义。修复后写回磁盘，用户下次启动自动恢复，无需手改配置文件。
 */
describe('非法 worker tier 值 — loadConfig 恢复', () => {
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-invalid-tier-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('patcherTier 存了 profile 名（cheap-flash）时回落默认，不再打死整份配置', () => {
    writeFileSync(configPath, JSON.stringify({
      workers: { profiles: {}, routing: {}, patcherTier: 'cheap-flash' },
    }))
    // 修复前：这里抛 ConfigLoadError（rivet 配置校验失败：workers.patcherTier）
    const cfg = loadConfig()
    assert.equal(cfg.workers.patcherTier, 'cheap')
  })

  it('escalationCap 非法值也回落 off', () => {
    writeFileSync(configPath, JSON.stringify({
      workers: { profiles: {}, routing: {}, escalationCap: 'cheap-flash' },
    }))
    assert.equal(loadConfig().workers.escalationCap, 'off')
  })

  it('合法的 tier 值原样保留（不误伤用户设置）', () => {
    writeFileSync(configPath, JSON.stringify({
      workers: { profiles: {}, routing: {}, patcherTier: 'strong', escalationCap: 'balanced' },
    }))
    const cfg = loadConfig()
    assert.equal(cfg.workers.patcherTier, 'strong')
    assert.equal(cfg.workers.escalationCap, 'balanced')
  })

  it('修复写回磁盘，下次启动不再需要修复', () => {
    writeFileSync(configPath, JSON.stringify({
      workers: { profiles: {}, routing: {}, patcherTier: 'cheap-flash' },
    }))
    loadConfig()
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as { workers?: { patcherTier?: unknown } }
    assert.equal(written.workers?.patcherTier, 'cheap')
  })
})
