import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectDeclaredPlatformPackages, planEnsureTargetPackages } from '../ensure-target-runtime-pkgs.js'

/** 在临时 node_modules 里造一个假包（只写 package.json）。 */
function fakePkg(nodeModules, name, pkg) {
  const dir = join(nodeModules, ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkg }))
}

test('planEnsureTargetPackages：macOS 交叉打 Windows 包时列出缺失的 win32 平台包', () => {
  const root = mkdtempSync(join(tmpdir(), 'ensure-target-pkgs-'))
  try {
    const nodeModules = join(root, 'node_modules')
    fakePkg(nodeModules, 'esbuild', {
      optionalDependencies: {
        '@esbuild/darwin-arm64': '0.28.1',
        '@esbuild/win32-x64': '0.28.1',
        '@esbuild/linux-x64': '0.28.1',
      },
    })
    fakePkg(nodeModules, '@esbuild/darwin-arm64', {})
    // 间接依赖同样要看：ast-grep 的平台包由 @ast-grep/napi 声明（win32 带 -msvc）
    fakePkg(nodeModules, '@ast-grep/napi', {
      optionalDependencies: { '@ast-grep/napi-win32-x64-msvc': '0.44.0' },
    })

    const plan = planEnsureTargetPackages({
      nodeModules,
      roots: ['esbuild', '@ast-grep/napi'],
      target: { os: 'win32', arch: 'x64' },
    })
    assert.deepEqual(
      plan.map(p => p.name).sort(),
      ['@ast-grep/napi-win32-x64-msvc', '@esbuild/win32-x64'],
    )
    assert.equal(plan.find(p => p.name === '@esbuild/win32-x64')?.range, '0.28.1')
    assert.equal(plan.find(p => p.name === '@esbuild/win32-x64')?.from, 'esbuild')

    // 宿主构建（darwin-arm64）：装了的都在 → 无缺失、no-op
    assert.deepEqual(
      planEnsureTargetPackages({
        nodeModules,
        roots: ['esbuild', '@ast-grep/napi'],
        target: { os: 'darwin', arch: 'arm64' },
      }),
      [],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectDeclaredPlatformPackages 遍历依赖闭包、不展开平台包自身', () => {
  const root = mkdtempSync(join(tmpdir(), 'ensure-target-pkgs-'))
  try {
    const nodeModules = join(root, 'node_modules')
    fakePkg(nodeModules, 'a', { dependencies: { b: '1.0.0' } })
    fakePkg(nodeModules, 'b', { optionalDependencies: { '@napi-rs/canvas-win32-x64-msvc': '3.0.0' } })
    // 平台包若声明了别的东西也不该被展开（它们是叶子）
    fakePkg(nodeModules, '@napi-rs/canvas-win32-x64-msvc', { dependencies: { sneaky: '1.0.0' } })
    fakePkg(nodeModules, 'sneaky', {})

    const declared = collectDeclaredPlatformPackages({ nodeModules, roots: ['a'] })
    assert.deepEqual(declared, [
      { name: '@napi-rs/canvas-win32-x64-msvc', range: '3.0.0', from: 'b' },
    ])
    // 缺失的普通依赖不进这份清单（那是 stage-runtime-deps 的 missing 分支的职责）
    assert.equal(declared.some(d => d.name === 'sneaky'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
