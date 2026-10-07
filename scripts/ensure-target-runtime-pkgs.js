#!/usr/bin/env node
/**
 * ensure-target-runtime-pkgs.js — 交叉构建时把**目标平台**的原生包补进本机
 * node_modules，供 stage-runtime-deps 收进 dist/node_modules。
 *
 * 为什么需要：
 *   npm 只安装与**宿主**平台匹配的可选依赖。macOS 交叉打 Windows 包
 *   （cargo-xwin，本机默认流程）时，宿主 node_modules 里只有
 *   @esbuild/darwin-arm64，而产物需要 @esbuild/win32-x64；stage-runtime-deps
 *   只从 node_modules 复制 → Windows 包里整个 @esbuild 目录缺席 → esbuild 在
 *   用户机上全程不可用，其安装手册被回显成「语法检查提示」（issue #366）。
 *
 * 做法：遍历 RUNTIME_BUNDLED 的依赖闭包，挑出「目标平台匹配但本机没有」的平台
 *   包，用 `npm pack <name>@<range>` 取 tarball 解到 node_modules/<name>。
 *   不写 package.json / lockfile，不重解析依赖树（`npm install --os` 会动整棵树，
 *   在共享工作区是危险的）。
 *
 * 幂等；目标平台 = 宿主时（常规构建、Windows 宿主）为 no-op。
 * 用法：node scripts/ensure-target-runtime-pkgs.js
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_BUNDLED } from './external-deps.js'
import {
  findMissingTargetPlatformPackages,
  parsePlatformPackage,
  resolveTargetPlatform,
} from './runtime-platform-filter.js'

/**
 * 遍历 roots 的依赖闭包，收集其中出现的平台包声明（含版本范围与声明者）。
 * 只读已安装包的 package.json——平台包自身不展开（它们是叶子）。
 *
 * @param {{ nodeModules: string, roots: string[] }} opts
 * @returns {Array<{ name: string, range?: string, from: string }>}
 */
export function collectDeclaredPlatformPackages({ nodeModules, roots }) {
  const declared = []
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const dir = join(nodeModules, name)
    if (!existsSync(join(dir, 'package.json'))) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) }
    for (const [dep, range] of Object.entries(deps)) {
      if (parsePlatformPackage(dep)) declared.push({ name: dep, range, from: name })
      else queue.push(dep)
    }
  }
  return declared
}

/**
 * 计算「目标平台需要、本机 node_modules 里没有」的平台包清单。
 *
 * @param {{ nodeModules: string, roots?: string[], target?: { os: string, arch: string } }} opts
 */
export function planEnsureTargetPackages({ nodeModules, roots = RUNTIME_BUNDLED, target }) {
  const declared = collectDeclaredPlatformPackages({ nodeModules, roots })
  return findMissingTargetPlatformPackages(
    declared,
    target ?? resolveTargetPlatform(),
    name => existsSync(join(nodeModules, name, 'package.json')),
  )
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const nodeModules = join(repoRoot, 'node_modules')
  const target = resolveTargetPlatform()
  const missing = planEnsureTargetPackages({ nodeModules, target })

  if (missing.length === 0) {
    console.log('✅ ensure-target-runtime-pkgs: %s-%s 平台包齐备，无需补齐', target.os, target.arch)
    process.exit(0)
  }

  console.log('… ensure-target-runtime-pkgs: 目标 %s-%s 缺 %d 个平台包，从 registry 补齐：', target.os, target.arch, missing.length)
  const failures = []
  for (const m of missing) {
    const spec = m.range ? `${m.name}@${m.range}` : m.name
    const staging = mkdtempSync(join(tmpdir(), 'tianshu-target-pkg-'))
    try {
      execFileSync('npm', ['pack', spec, '--pack-destination', staging], {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'inherit'],
        windowsHide: true,
      })
      const tgz = readdirSync(staging).find(f => f.endsWith('.tgz'))
      if (!tgz) throw new Error(`npm pack ${spec} 未产出 tarball`)
      execFileSync('tar', ['-xzf', join(staging, tgz), '-C', staging], {
        stdio: ['ignore', 'ignore', 'inherit'],
        windowsHide: true,
      })
      const unpacked = join(staging, 'package')
      if (!existsSync(join(unpacked, 'package.json'))) throw new Error(`${spec} tarball 结构异常（无 package/package.json）`)
      const dest = join(nodeModules, m.name)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(unpacked, dest, { recursive: true })
      console.log('  ✅ %s  （声明于 %s）', m.name, m.from)
    } catch (err) {
      failures.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`)
      console.error('  ✗ %s 补齐失败：%s', m.name, err instanceof Error ? err.message : String(err))
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  if (failures.length > 0) {
    console.error('')
    console.error('✗ ensure-target-runtime-pkgs: %d 个包补齐失败，构建不该继续（会写出残缺的 %s-%s 包）。', failures.length, target.os, target.arch)
    for (const f of failures) console.error('    %s', f)
    process.exit(1)
  }
  console.log('✅ ensure-target-runtime-pkgs: 已补齐 %d 个目标平台包（%s-%s）', missing.length, target.os, target.arch)
}
