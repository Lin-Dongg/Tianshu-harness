import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findMissingTargetPlatformPackages,
  isForeignPlatformPackage,
  parsePlatformPackage,
  resolveTargetPlatform,
} from '../runtime-platform-filter.js'

const darwinArm64 = { os: 'darwin', arch: 'arm64' }
const darwinX64 = { os: 'darwin', arch: 'x64' }
const linuxX64 = { os: 'linux', arch: 'x64' }
const winX64 = { os: 'win32', arch: 'x64' }

test('isForeignPlatformPackage detects @esbuild platform pkgs', () => {
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-x64', darwinArm64), true)
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', darwinArm64), false)
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', darwinX64), true)
  assert.equal(isForeignPlatformPackage('@esbuild/linux-x64', linuxX64), false)
})

test('isForeignPlatformPackage 按 OS 过滤（issue #366：同架构异系统）', () => {
  // 交叉构建 macOS → win-x64 时，宿主装着的 darwin 包与目标 win32 包必须分开判：
  // 前者不得进包（白占体积），后者缺席必须被发现（此前两个都当「host 平台」）。
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', winX64), true)
  assert.equal(isForeignPlatformPackage('@esbuild/win32-x64', winX64), false)
  assert.equal(isForeignPlatformPackage('@esbuild/linux-x64', winX64), true)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-win32-x64-msvc', winX64), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-arm64', winX64), true)
  // ia32 变体永远 foreign（桌面只发 arm64|x64）
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-win32-ia32-msvc', winX64), true)
})

test('isForeignPlatformPackage detects @ast-grep napi pkgs', () => {
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-x64', darwinArm64), true)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-arm64', darwinArm64), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi', darwinArm64), false)
  // musl 变体永远 foreign（桌面 glibc 基准;linuxdeploy 对 musl .node 跑 ldd 会崩）
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-linux-x64-musl', linuxX64), true)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-linux-x64-gnu', linuxX64), false)
  assert.equal(isForeignPlatformPackage('napi-linux-x64-musl', linuxX64), true)
})

test('isForeignPlatformPackage detects @napi-rs pkgs（pdfjs-dist → canvas）', () => {
  // 2026-09-13 Linux AppImage 实证：@napi-rs/canvas-linux-x64-musl 混入 staging
  // → linuxdeploy 对该 .node 跑 ldd 退出码 1 → std::runtime_error 打包崩。
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-linux-x64-musl', linuxX64), true)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-linux-x64-gnu', linuxX64), false)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-linux-arm64-gnu', linuxX64), true)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-darwin-arm64', darwinArm64), false)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-darwin-x64', darwinArm64), true)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-win32-x64-msvc', winX64), false)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-win32-x64-msvc', darwinArm64), true)
  // 包本体（无平台后缀）永远保留
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas', winX64), false)
})

test('isForeignPlatformPackage leaves non-platform packages alone', () => {
  assert.equal(isForeignPlatformPackage('esbuild', darwinArm64), false)
  assert.equal(isForeignPlatformPackage('typescript', darwinArm64), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/lang-python', darwinArm64), false)
})

test('parsePlatformPackage 解析三种平台包命名', () => {
  assert.deepEqual(parsePlatformPackage('@esbuild/win32-x64'), { os: 'win32', arch: 'x64', libc: undefined })
  assert.deepEqual(parsePlatformPackage('@ast-grep/napi-linux-x64-gnu'), { os: 'linux', arch: 'x64', libc: 'gnu' })
  assert.deepEqual(parsePlatformPackage('@ast-grep/napi-win32-x64-msvc'), { os: 'win32', arch: 'x64', libc: 'msvc' })
  assert.deepEqual(parsePlatformPackage('@napi-rs/canvas-darwin-arm64'), { os: 'darwin', arch: 'arm64', libc: undefined })
  assert.deepEqual(parsePlatformPackage('@napi-rs/canvas-win32-x64-msvc'), { os: 'win32', arch: 'x64', libc: 'msvc' })
  // 非平台包 → null（这些包永远保留）
  assert.equal(parsePlatformPackage('esbuild'), null)
  assert.equal(parsePlatformPackage('@ast-grep/napi'), null)
  assert.equal(parsePlatformPackage('@ast-grep/lang-python'), null)
  // esbuild 的非桌面平台包（arch token 未收录）→ null，不参与判定
  assert.equal(parsePlatformPackage('@esbuild/openharmony-arm64'), null)
})

test('resolveTargetPlatform：triple 优先、宿主兜底', () => {
  assert.deepEqual(resolveTargetPlatform({ triple: 'x86_64-pc-windows-msvc', platform: 'darwin', arch: 'arm64' }), winX64)
  assert.deepEqual(resolveTargetPlatform({ triple: 'aarch64-apple-darwin', platform: 'win32', arch: 'x64' }), darwinArm64)
  assert.deepEqual(resolveTargetPlatform({ triple: 'x86_64-unknown-linux-gnu', platform: 'darwin', arch: 'arm64' }), linuxX64)
  // 无 triple → 宿主（含 ia32/armv7 归一到 x64：桌面只发 arm64|x64）
  assert.deepEqual(resolveTargetPlatform({ triple: '', platform: 'darwin', arch: 'arm64' }), darwinArm64)
  assert.deepEqual(resolveTargetPlatform({ triple: '', platform: 'win32', arch: 'x64' }), winX64)
  assert.deepEqual(resolveTargetPlatform({ triple: '', platform: 'linux', arch: 'ia32' }), linuxX64)
})

test('findMissingTargetPlatformPackages 只报「目标平台需要但不存在」的包', () => {
  const declared = [
    { name: '@esbuild/darwin-arm64', range: '0.28.1', from: 'esbuild' },
    { name: '@esbuild/win32-x64', range: '0.28.1', from: 'esbuild' },
    { name: '@esbuild/linux-x64', range: '0.28.1', from: 'esbuild' },
    { name: 'esbuild', from: 'root' }, // 非平台包，忽略
  ]
  const installed = new Set(['@esbuild/darwin-arm64'])

  // macOS 交叉打 Windows 包（issue #366 现场）：win32-x64 缺席必须被报出来
  assert.deepEqual(
    findMissingTargetPlatformPackages(declared, winX64, n => installed.has(n)),
    [{ name: '@esbuild/win32-x64', range: '0.28.1', from: 'esbuild' }],
  )
  // 宿主构建：目标平台包在，无缺失
  assert.deepEqual(
    findMissingTargetPlatformPackages(declared, darwinArm64, n => installed.has(n)),
    [],
  )
  // 重复声明只报一次
  assert.deepEqual(
    findMissingTargetPlatformPackages(
      [...declared, { name: '@esbuild/win32-x64', range: '^0.28.1', from: 'other' }],
      winX64,
      n => installed.has(n),
    ).length,
    1,
  )
})
