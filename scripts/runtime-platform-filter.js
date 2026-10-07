/**
 * 目标平台解析 + 平台包过滤。stage-runtime-deps.js / ensure-target-runtime-pkgs.js
 * 与各自的测试共用同一判据。
 *
 * 2026-10-06（issue #366）：过滤此前只有 **arch** 一个维度，且「目标平台的包
 * 压根不在 node_modules 里」时静默跳过。macOS 交叉打 Windows 包（cargo-xwin，
 * 本机默认流程）时：宿主装了 @esbuild/darwin-arm64，keepArch=x64 把它当异架构
 * 挡掉，而 @esbuild/win32-x64 在宿主 node_modules 里不存在 → 静默 continue →
 * 产物 rivet-runtime/node_modules/@esbuild 整个不存在 → Windows 上 esbuild
 * 全程不可用，其安装手册被回显成「语法检查提示」。
 *
 * 现在两条一起改：OS 也是过滤维度；目标平台包缺席由 stage-runtime-deps
 * fail loud（findMissingTargetPlatformPackages），绝不再静默出坏包。
 */

/** 平台包命名模式 → 捕获组含义。非平台包（`@ast-grep/napi` 本体、`esbuild`…）
 *  一律不匹配，永远保留。 */
const PLATFORM_PACKAGE_PATTERNS = [
  // esbuild：@esbuild/<os>-<arch>
  { re: /^@esbuild\/(darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix)-(arm64|x64|ia32|arm)$/, os: 1, arch: 2 },
  // @ast-grep/napi-<os>-<arch>[-<libc>]（win32 变体带 -msvc：napi-win32-x64-msvc；
  // ia32/armv7 也列进来，好让它们走「永远 foreign」分支而不是当非平台包放行）
  { re: /^@ast-grep\/napi-(darwin|linux|win32)-(arm64|x64|ia32|arm)(?:-(gnu|musl|msvc))?$/, os: 1, arch: 2, libc: 3 },
  { re: /^napi-(darwin|linux|win32)-(arm64|x64|ia32|arm)(?:-(gnu|musl|msvc))?$/, os: 1, arch: 2, libc: 3 },
  // @napi-rs 系（pdfjs-dist → @napi-rs/canvas 等）：命名 <pkg>-<os>-<arch>[-<libc>]，
  // win32 的 libc 是 msvc（非 musl，与 gnu 同视为可留）。
  { re: /^@napi-rs\/[a-z0-9-]+-(darwin|linux|win32|android|freebsd)-(arm64|x64|ia32|arm)(?:-(gnu|musl|msvc))?$/, os: 1, arch: 2, libc: 3 },
]

/**
 * 解析平台包名。
 * @param {string} name 包名，如 @esbuild/win32-x64、@napi-rs/canvas-darwin-arm64
 * @returns {{ os: string, arch: string, libc?: string } | null} null = 非平台包
 */
export function parsePlatformPackage(name) {
  for (const p of PLATFORM_PACKAGE_PATTERNS) {
    const m = name.match(p.re)
    if (m) {
      return {
        os: m[p.os],
        arch: m[p.arch],
        libc: p.libc ? m[p.libc] : undefined,
      }
    }
  }
  return null
}

/**
 * 解析目标平台 —— 交叉构建取 TAURI_ENV_TARGET_TRIPLE，否则回退宿主。
 * OS token 与包名同口径（darwin / linux / win32）；arch 归一到 arm64|x64
 * （桌面只发这两档，ia32/armv7 一律视为异平台）。
 *
 * @param {{ triple?: string, platform?: string, arch?: string }} [env]
 * @returns {{ os: string, arch: 'arm64' | 'x64' }}
 */
export function resolveTargetPlatform({
  triple = process.env.TAURI_ENV_TARGET_TRIPLE || '',
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const t = String(triple || '').trim()
  const hostOs = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  let os = hostOs
  if (t) {
    if (t.includes('windows')) os = 'win32'
    else if (t.includes('darwin')) os = 'darwin'
    else if (t.includes('linux')) os = 'linux'
  }
  const tok = t ? t.split('-')[0] : ''
  let rawArch = arch
  if (tok === 'aarch64' || tok === 'arm64') rawArch = 'arm64'
  else if (tok === 'x86_64') rawArch = 'x64'
  else if (tok === 'i686') rawArch = 'x86'
  return { os, arch: rawArch === 'arm64' ? 'arm64' : 'x64' }
}

/**
 * 该包是否属于「非目标平台」（异 OS 或异架构，或永远排除的 musl/ia32/armv7）。
 *
 * @param {string} name 包名
 * @param {{ os: string, arch: string }} target 目标平台（resolveTargetPlatform 的产物）
 * @returns {boolean} true = 异平台，不得进入 staging
 */
export function isForeignPlatformPackage(name, target) {
  const p = parsePlatformPackage(name)
  if (!p) return false
  // Desktop ships only arm64/x64. Treat ia32/armv7 as always foreign.
  if (p.arch === 'ia32' || p.arch === 'arm') return true
  // musl 变体永远 foreign：桌面基准是 glibc（ubuntu 构建），musl .node 会让
  // linuxdeploy 的 ldd 退出码 1 直接崩（2026-09-03 Linux AppImage 实证；
  // 2026-09-13 @napi-rs/canvas-linux-x64-musl 复发——pdfjs-dist 带入）。
  if (p.libc === 'musl') return true
  if (p.arch !== target.arch) return true
  // OS 维度（issue #366 新增）：同架构不同系统同样不能混进包里——
  // win32-x64 包塞进 macOS 产物只是白占体积，反过来则是目标能力整块缺席。
  return p.os !== target.os
}

/**
 * 找出「依赖图声明过、目标平台需要、但本机 node_modules 里没有」的平台包。
 * 这是 issue #366 的静态形态：`@esbuild/win32-x64` 声明的 optionalDependency
 * 在 macOS 宿主上不存在，staging 静默跳过 → 出包缺 esbuild 运行时。
 *
 * @param {Array<string | { name: string, range?: string, from?: string }>} declared
 * @param {{ os: string, arch: string }} target
 * @param {(name: string) => boolean} exists 该包在本机 node_modules 是否可见
 * @returns {Array<{ name: string, range?: string, from?: string }>}
 */
export function findMissingTargetPlatformPackages(declared, target, exists) {
  const out = []
  const seen = new Set()
  for (const entry of declared) {
    const name = typeof entry === 'string' ? entry : entry.name
    if (!parsePlatformPackage(name)) continue
    if (isForeignPlatformPackage(name, target)) continue
    if (seen.has(name)) continue
    seen.add(name)
    if (exists(name)) continue
    out.push(typeof entry === 'string' ? { name } : entry)
  }
  return out
}
