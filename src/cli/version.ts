/**
 * `rivet --version` 的版本解析——不依赖 tui/updater.ts。
 *
 * 为什么不用 updater 的 `detectInstallRoot` / `getCurrentVersion`（2026-09-16
 * P0-2）：`tui/updater.ts` 静态 import undici（`ProxyAgent`）与镜像/代理解析，
 * 一个 --version 不值得拉起 ~1MB 的闭包。这里用 node:fs 重实现同一语义：
 * 从 argv[1]（bin 路径）真实路径向上找最近的、带 `version` 字段的 package.json。
 *
 * 2026-09-16 晚：updater 的 `detectInstallRoot` / `getCurrentVersion` 已反过来委托
 * 本模块——原来的「找到第一个 package.json 就返回」会被工作区 `dist/package.json`
 * （只有 `{"type":"module"}`，由 stage-runtime-deps.js 为脱离仓库分发而写）劫持，
 * 于是 root 变成 `<pkg>/dist`：欢迎页版本号消失、更新检查拿不到包名。两处不再各自
 * 留一份实现；本地开发与发布包都拿真版本。
 * 找不到时同样回退 `unknown`，保持输出形状不变。
 *
 * 2026-09-16 二修（审查发现的回归）：只校验「有 version 字段」还不够——runtime
 * bundle 的布局没有根级 package.json（build-runtime-bundle.sh 只写 version.txt），
 * 若它被解压进一个自带 package.json 的目录树，会继续上溯并命中那个**无关项目**，
 * 把别人的版本当成 CLI 版本显示出来——比不显示更坏。故改为同时校验 name 是本包。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 本包名——用于确认找到的声明属于本包，而非祖先链上无关项目的。 */
const PACKAGE_NAME = 'tianshu-harness'

/**
 * 改名前的旧包名（3.22.x 及更早以 tianshu-tui 发布）。过渡期身份校验双认：
 * 旧全局安装的 package.json 仍是旧名，不兼容则版本探测/更新检查对存量用户失效。
 */
const LEGACY_PACKAGE_NAME = 'tianshu-tui'

/** 从脚本路径（默认 argv[1]）向上找最近的、**属于本包**的 package.json 目录。 */
export function findInstallRoot(scriptPath: string | undefined = process.argv[1]): string | null {
  if (!scriptPath) return null
  let dir: string
  try {
    dir = dirname(realpathSync(scriptPath))
  } catch {
    dir = dirname(scriptPath)
  }
  for (let i = 0; i < 20; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown; version?: unknown }
        // name 必须匹配：只认本包的声明（含改名前的旧包名）。只看 version 会命中
        // 外层无关项目（runtime bundle 解压进别人的项目目录时），把他人版本当成本包版本。
        if ((parsed.name === PACKAGE_NAME || parsed.name === LEGACY_PACKAGE_NAME) && typeof parsed.version === 'string' && parsed.version.length > 0) {
          // Staged dist carries product metadata too; a source/npm installation
          // still owns its parent package root (including updater install type).
          if (basename(dir) === 'dist') {
            const parentRoot = findInstallRoot(join(dirname(dir), 'package.json'))
            if (parentRoot === dirname(dir)) return parentRoot
          }
          return dir
        }
      } catch {
        // 坏包声明不终止查找——继续向上（与版本兜底同一个 fail-open 姿态）。
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 读取 install root 的 version 字段；失败返回 null。 */
export function readInstallVersion(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
  } catch {
    return null
  }
}

/** 当前安装版本；找不到回退 `unknown`（launcher 的 CLI 编译缓存按它分目录）。 */
export function currentInstallVersion(scriptPath?: string): string {
  const root = findInstallRoot(scriptPath)
  const version = root ? readInstallVersion(root) : null
  return version ?? 'unknown'
}

/** `tianshu-harness vX.Y.Z\n` —— main.ts 与 launcher 共用的 --version 输出。 */
export function formatVersionLine(scriptPath?: string): string {
  return `${PACKAGE_NAME} v${currentInstallVersion(scriptPath)}\n`
}
