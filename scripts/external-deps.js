/**
 * external-deps.js — 单一数据源：dist 运行时外部依赖清单。
 *
 * 收敛四处曾各自维护、靠人工同步的清单（2026-08-10 之前）：
 *   - tsup.config.ts `external`（打包器不内联）
 *   - tsup.config.ts `noExternal`（强制内联进主 bundle，即 FORCE_BUNDLED）
 *   - scripts/runtime-import-scan.js `ALLOWED_EXTERNALS`（dist 裸导入扫描允许集）
 *   - scripts/stage-runtime-deps.js `ROOTS`（随包分发到 dist/node_modules 的载荷）
 *
 * 语义分层（不是同一份列表的多次复制）：
 *   - FORCE_BUNDLED —— 必须内联进主 bundle 的纯 JS 依赖（tsup noExternal 的来源）。
 *     打包 sidecar 不含 node_modules，留成裸导入即 ERR_MODULE_NOT_FOUND。
 *   - RUNTIME_BUNDLED —— 必须随包分发才能在打包 sidecar 中解析的包
 *     （stage-runtime-deps ROOTS 的直接来源）。
 *   - SCAN_ALLOWED —— dist 产物中允许出现的裸导入全集（runtime-import-scan
 *     的允许集）。= RUNTIME_BUNDLED ∪ 特性门后惰性解析/可选依赖。
 *
 * 每个 package.json runtime 依赖必须落在 FORCE_BUNDLED ∪ RUNTIME_BUNDLED ∪
 * SCAN_ALLOWED 之一，否则 dist 会留下无法随包解析的裸导入（守卫见
 * scripts/__tests__/external-deps.test.ts）。
 *
 * 不变量（verifyConsistency 强制）：
 *   1. RUNTIME_BUNDLED ⊆ SCAN_ALLOWED —— 随包分发的包必然以裸导入出现在产物里；
 *   2. 三清单各自无重复；
 *   3. FORCE_BUNDLED ∩ RUNTIME_BUNDLED = ∅ —— 同一包不能既内联又随包分发
 *      （2026-08-10 收敛）。exceljs 曾同时出现在 noExternal 与 ROOTS（注释互相
 *      矛盾），已裁定走随包分发路线：doc-extract.ts 是变量动态 import + 缺失时
 *      降级 soffice，22MB 不进主 bundle。
 *
 * 修改依赖清单只改这里；改完跑 `npm run build` 与
 * `node scripts/assert-runtime-imports.js` 验证两条链。
 */

/** 强制内联进主 bundle 的纯 JS 依赖（tsup `noExternal` 的来源）。
 *  与 RUNTIME_BUNDLED 互斥（不变量 3）——单一数据源，勿在 tsup.config.ts 另起一份。
 *  判定：纯 JS、无 native/wasm、可被 esbuild 打包。留成裸导入 = 打包后必崩。 */
export const FORCE_BUNDLED = [
  'string-width',
  'get-east-asian-width',
  'chalk',
  'ink',
  'react',
  'diff',
  'undici',
  'zod',
  // zod 的伴生纯 JS 库（worker 收尾轮 schema 转换）：必须内联。2026-09-18 它被
  // 声明进 dependencies（幽灵依赖收口）后 tsup 按「deps 默认 external」不再内联，
  // dist 裸导入过不了 assert-runtime-imports——声明合规与打包形态要同时满足。
  'zod-to-json-schema',
  '@modelcontextprotocol/sdk',
  'turndown',
  'pixelmatch',
  'pngjs',
  // skills 系统的 YAML frontmatter 解析（skill-metadata/drafts/management/
  // distill）。4940f9c94（skills 统一）随 dependencies 加入却未归类 → dist 4 个
  // chunk 留裸 `from "yaml"` → assert-runtime-imports 红。纯 JS、无子依赖，内联。
  'yaml',
]

/** 随包分发到 dist/node_modules 的根包（stage-runtime-deps ROOTS 的来源）。
 *  每项注释说明"为什么不能内联进主 bundle"。 */
export const RUNTIME_BUNDLED = [
  'esbuild', // syntax-check JS/TS parser（native Go binary）
  'typescript', // in-process tsc LSP fallback
  '@ast-grep/napi', // structural search / ast-edit（native addon）
  '@ast-grep/lang-json',
  '@ast-grep/lang-python',
  'web-tree-sitter', // tree-sitter chunker（wasm loader）
  'tree-sitter-wasms', // grammar .wasm 文件（按路径加载）
  'playwright-core', // headless chromium driver（变量化动态 import——tsup 无法内联）
  'exceljs', // Office .xlsx 读写（文档附件管线）。变量动态 import + 缺失降级
  // soffice；纯 JS 体积 ~22MB 不宜内联进主 bundle，随包分发。
  'jszip', // bounded OOXML/ODF archive reader; also shared with ExcelJS
  'saxes', // namespace-aware Office XML parser
  'pdfjs-dist', // .pdf 文本抽取兜底引擎（pdftotext 缺失时顶上的纯 JS 路径）。
  // 动态 import legacy/build/pdf.mjs + standard_fonts 按路径加载——不能内联，随包分发。
]

/** dist 产物裸导入扫描允许集（runtime-import-scan ALLOWED_EXTERNALS 的来源）。 */
export const SCAN_ALLOWED = [
  ...RUNTIME_BUNDLED,
  // native 动态加载：走 native-resolver 专用通道（wrapper 由
  // stage-cli-sqlite-wrapper.js 单独分发，native 二进制由 pack-native.js 打包），
  // 不进 RUNTIME_BUNDLED 的 closure 复制。
  'better-sqlite3',
  // dev-only devtools（ink 的可选依赖）；未安装时 ink devtools 不可用，
  // 主功能不依赖，不随包分发。
  'react-devtools-core',
  // optional Office docx reader（npm i mammoth），走 lazy，不随包分发。
  'mammoth',
  // 可选剪贴板原生库，未安装时静默回退 shell 链；当前无消费点，仅预留。
  '@mariozechner/clipboard',
  // Landlock 沙箱 launcher（Linux 预编译二进制经其自身 optionalDeps 分发）。
  // 惰性 require + probe fail-closed：未安装/非 Linux/内核不强制 → 探测失败
  // → 回退 bwrap/firejail 之后的 none（sandbox-profile.ts defaultLandlockUsable）。
  // 不进 RUNTIME_BUNDLED（桌面 mac/win 用不到 Linux 二进制）。
  '@huiliyi37/node-addon-landlock-run',
]

/** 一致性校验。默认校验本模块导出的清单；测试可注入伪造清单。 */
export function verifyConsistency({
  runtimeBundled = RUNTIME_BUNDLED,
  scanAllowed = SCAN_ALLOWED,
  forceBundled = FORCE_BUNDLED,
} = {}) {
  const dup = (name, list) => {
    const seen = new Set()
    for (const item of list) {
      if (seen.has(item)) throw new Error(`external-deps: ${name} 含重复条目 '${item}'`)
      seen.add(item)
    }
  }
  dup('RUNTIME_BUNDLED', runtimeBundled)
  dup('SCAN_ALLOWED', scanAllowed)
  dup('FORCE_BUNDLED', forceBundled)

  const overlap = forceBundled.filter((n) => runtimeBundled.includes(n))
  if (overlap.length > 0) {
    throw new Error(
      `external-deps: FORCE_BUNDLED ∩ RUNTIME_BUNDLED 非空: ${overlap.join(', ')} — 同一包不能既内联又随包分发（不变量 3）`,
    )
  }

  const allowedSet = new Set(scanAllowed)
  const missing = runtimeBundled.filter((p) => !allowedSet.has(p))
  if (missing.length > 0) {
    throw new Error(
      `external-deps: RUNTIME_BUNDLED ⊆ SCAN_ALLOWED 不成立，缺失: ${missing.join(', ')}`,
    )
  }
}
