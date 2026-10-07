#!/usr/bin/env bash
# 天枢 Windows 打包脚本（macOS 跨打版 —— 本机默认流程，2026-09-28 起）
# 用法: bash scripts/build-windows-release-cross.sh
# 宿主: macOS（Apple Silicon 实测）；目标: Windows x86_64
# 原理: tauri build --runner cargo-xwin（官方支持的跨打路径，见
#   https://v2.tauri.app/distribute/windows-installer/ 的 "Build Windows apps on
#   Linux and macOS"）。Windows 宿主走 build-windows-release.sh。
#
# 工具链（一次性准备）:
#   brew install llvm lld nsis        # llvm-lib/llvm-rc + lld-link + makensis
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
#
# 签名:
#   updater .sig：TAURI_SIGNING_PRIVATE_KEY（跨平台无差别，兜底 ~/.tauri/tianshu.key）
#   运行时完整性：RIVET_RELEASE_KEY_PKCS8（兜底 ~/.tianshu/release.key）
#   Authenticode：与 Windows 宿主同规则——TIANSHU_SIGN_CMD，或本地构建显式
#     TIANSHU_ALLOW_UNSIGNED=1 放行（未签名安装包会被 SmartScreen/杀毒拦，见
#     desktop/DISTRIBUTION.md「Windows」）。
#
# 边界:
#   · 只出 NSIS（updater 走 NSIS setup.exe + .sig）。MSI 受 WiX 限制只能在
#     Windows 出，跨打不提供（仅手动分发用，真要时在 Windows 宿主补打）。
#   · signCommand 经 -c 注入绝对路径的 win-codesign.mjs：tauri.conf.json 里的
#     相对路径在跨打 cwd 下解析不到（Windows 宿主无恙，2026-09-28 实踩）。
#
# 产物:
#   release/Tianshu_<VER>_x64-setup.exe
#   release/Tianshu_<VER>_x64-setup.exe.sig
#   release/windows-repair/（WebView2 预窗口修复工具）
#   release/latest.json（仅更新 windows-x86_64 条目，保留 macOS 条目）
set -euo pipefail
cd "$(dirname "$0")/.."

# 版本号以 package.json 为准（同 build-windows-release.sh / build-macos-release.sh 范式）。
VER="$(node -p "require('./package.json').version")"
echo "=== 天枢 Windows 跨打 v${VER}（macOS → win-x64，cargo-xwin）==="

# 0. 跨打工具链硬闸门
LLVM_BIN="$(brew --prefix llvm 2>/dev/null || echo /nonexistent)/bin"
LLD_BIN="$(brew --prefix lld 2>/dev/null || echo /nonexistent)/bin"
MISSING=()
command -v cargo-xwin >/dev/null 2>&1 || MISSING+=("cargo-xwin → cargo install --locked cargo-xwin")
rustup target list --installed 2>/dev/null | grep -q '^x86_64-pc-windows-msvc$' || MISSING+=("rustup target add x86_64-pc-windows-msvc")
{ [ -x "$LLVM_BIN/llvm-lib" ] && [ -x "$LLVM_BIN/llvm-rc" ]; } || MISSING+=("llvm → brew install llvm（提供 llvm-lib / llvm-rc）")
[ -x "$LLD_BIN/lld-link" ] || MISSING+=("lld → brew install lld（提供 lld-link）")
command -v makensis >/dev/null 2>&1 || MISSING+=("nsis → brew install nsis（提供 makensis）")
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '✗ 跨打工具链缺失，请先装：\n  %s\n' "${MISSING[@]}" >&2
  exit 1
fi
export PATH="$LLVM_BIN:$LLD_BIN:$PATH"
echo "工具链: $(cargo-xwin --version) / makensis $(makensis -VERSION)"

# Authenticode 闸门（与 desktop/scripts/win-codesign.mjs 同语义，提前一轮给人话）
if [[ -z "${TIANSHU_SIGN_CMD:-}" && "${TIANSHU_ALLOW_UNSIGNED:-}" != "1" ]]; then
  echo "✗ 未配置 TIANSHU_SIGN_CMD（Windows Authenticode 签名命令）。" >&2
  echo "  本地开发构建显式放行：TIANSHU_ALLOW_UNSIGNED=1 bash $0" >&2
  echo "  正式发版签名接入见 desktop/DISTRIBUTION.md「Windows」。" >&2
  exit 1
fi

# 签名私钥：updater .sig（同 build-windows-release.sh 的兜底约定）
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -f "$HOME/.tauri/tianshu.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/tianshu.key"
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo "✗ TAURI_SIGNING_PRIVATE_KEY_PATH 指向的文件不存在: $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "✗ 未设置 TAURI_SIGNING_PRIVATE_KEY。Windows 自动更新必须带签名。" >&2
  exit 1
fi
: "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:=}"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# 运行时完整性签名私钥（v3.22.0 起必带，desktop/scripts/sign-runtime-integrity.js）
if [[ -z "${RIVET_RELEASE_KEY_PKCS8:-}" && -f "$HOME/.tianshu/release.key" ]]; then
  export RIVET_RELEASE_KEY_PKCS8="$(cat "$HOME/.tianshu/release.key")"
  echo "完整性签名私钥: ~/.tianshu/release.key（已导出）"
fi

# 1. 版本一致性（与 build-windows-release.sh 同一闸门：root/desktop/tauri.conf/
#    Cargo.toml/Cargo.lock 五处版本必须齐——漏改 Cargo.lock 会阻塞 git pull）
node -e "
const r=require('./package.json'), d=require('./desktop/package.json');
const tc=require('./desktop/src-tauri/tauri.conf.json');
const cargo = require('fs').readFileSync('./desktop/src-tauri/Cargo.toml','utf8');
const cargoVer = cargo.match(/^version\\s*=\\s*['\"]([^'\"]+)['\"]/m)?.[1];
if(r.version!=='$VER') throw new Error('root version mismatch: '+r.version);
if(d.version!=='$VER') throw new Error('desktop version mismatch: '+d.version);
if(tc.version!=='$VER') throw new Error('tauri.conf.json version mismatch: '+tc.version);
if(cargoVer!=='$VER') throw new Error('Cargo.toml version mismatch: '+cargoVer);
const lockVer = require('fs').readFileSync('./desktop/src-tauri/Cargo.lock','utf8')
  .match(/name\\s*=\\s*\"tianshu-desktop\"\\nversion\\s*=\\s*\"([^\"]+)\"/)?.[1];
if(lockVer!=='$VER') throw new Error('Cargo.lock 的 tianshu-desktop 版本不一致: '+(lockVer||'(未找到)')+'（期望 ${VER}）——修法：改 desktop/src-tauri/Cargo.lock 里 tianshu-desktop 的 version 行。');
console.log('版本校验通过: root='+r.version+' desktop='+d.version+' tauri='+tc.version+' cargo='+cargoVer+' lock='+lockVer)
"

# 2. 构建 CLI（beforeBuildCommand 还会重跑桌面端与全 staging 链——
#    fetch-node-runtime/fetch-shell-runtime/fetch-whisper-runtime/fetch-ripgrep/
#    pack-native 均已按 TAURI_ENV_TARGET_TRIPLE 目标化，见 f5ca4c58e）
#
#    前置换平台包：npm 只安装**宿主**平台的可选依赖，macOS 上因此没有
#    @esbuild/win32-x64 / @ast-grep/napi-win32-x64-msvc / @napi-rs/canvas-win32-x64-msvc。
#    stage-runtime-deps 只从 node_modules 复制，缺了就静默跳过 → 产物在 Windows 上
#    esbuild（语法检查）与 ast-grep 全程不可用，其安装手册还会被当成「语法检查提示」
#    回显给用户（issue #366）。stage 也会对缺失 fail loud，这里是它的正规修法。
echo "--- 补齐目标平台原生包（win32-x64）---"
TAURI_ENV_TARGET_TRIPLE="x86_64-pc-windows-msvc" node scripts/ensure-target-runtime-pkgs.js

echo "--- 构建 CLI ---"
npm run build

# 3. 清理旧产物（签名新鲜度闸门依赖，同 build-windows-release.sh）
BUNDLE_DIR="desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
rm -rf "$BUNDLE_DIR/nsis" "$BUNDLE_DIR/msi"

# 4. Tauri 跨打 — NSIS only
echo "=== 构建 Windows x86_64（cargo-xwin runner）==="
cd desktop
node scripts/check-mobile-wiring.js
# signCommand 注入绝对路径：tauri.conf.json 的相对路径以 desktop/ 为锚，
# 跨打时 bundler 的 cwd 不在 desktop/ 会 MODULE_NOT_FOUND（2026-09-28 实踩）。
npm run tauri:build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis \
  -c "{\"bundle\":{\"windows\":{\"signCommand\":\"node $PWD/scripts/win-codesign.mjs %1\"}}}"
node scripts/assert-mobile-bundle.js src-tauri/resources
cd ..

# 产物内容完整性断言（同 build-windows-release.sh：dist 缺 main.js / cli/entry.js 拒打）
for f in dist/main.js dist/cli/entry.js; do
  if [ ! -f "$f" ]; then
    echo "✗ 缺少 $f——dist 未构建或产物不全，拒绝打包" >&2
    exit 1
  fi
done
echo "  ✅ dist/main.js + dist/cli/entry.js 就位"

# 5. 收集产物
mkdir -p release
NSIS_DIR="$BUNDLE_DIR/nsis"
SETUP="Tianshu_${VER}_x64-setup.exe"
SETUP_SIG="${SETUP}.sig"

if [[ ! -f "$NSIS_DIR/$SETUP" ]]; then
  echo "✗ 未找到 NSIS 安装包: $NSIS_DIR/$SETUP" >&2
  exit 1
fi
if [[ ! -f "$NSIS_DIR/$SETUP_SIG" ]]; then
  echo "✗ 未找到 NSIS 签名文件: ${NSIS_DIR}/${SETUP_SIG}（检查 TAURI_SIGNING_PRIVATE_KEY）" >&2
  exit 1
fi
# 签名新鲜度闸门：.sig 不得早于 .exe（同 build-windows-release.sh）
if [ "$NSIS_DIR/$SETUP_SIG" -ot "$NSIS_DIR/$SETUP" ]; then
  echo "✗ ${SETUP_SIG} 比 ${SETUP} 旧（签名未随本次构建刷新），拒绝发布陈旧签名" >&2
  exit 1
fi

cp "$NSIS_DIR/$SETUP" "release/$SETUP"
cp "$NSIS_DIR/$SETUP_SIG" "release/$SETUP_SIG"
echo "  ✅ release/$SETUP"
echo "  ✅ release/$SETUP_SIG"

REPAIR_DIR="desktop/scripts/windows"
mkdir -p release/windows-repair
cp "$REPAIR_DIR/webview2.ps1" "$REPAIR_DIR/repair-webview2.ps1" "$REPAIR_DIR/repair-webview2.cmd" "$REPAIR_DIR/README.md" release/windows-repair/
echo "  ✅ release/windows-repair/ (WebView2 预窗口修复)"

# 6. 更新 latest.json 的 windows-x86_64 条目（与 build-windows-release.sh 同一实现：
#    签名时间戳新鲜度闸门 + 旧版本条目剪除到 PENDING-PLATFORMS.txt）
node -e "
const fs = require('fs');
const sig = fs.readFileSync('release/$SETUP_SIG', 'utf8').trim();
const manifestPath = 'latest.json';
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { version: '$VER', notes: '', pub_date: new Date().toISOString(), platforms: {} };
manifest.version = '$VER';
manifest.pub_date = new Date().toISOString();
manifest.platforms['windows-x86_64'] = {
  url: 'https://github.com/huiliyi37/Tianshu-harness/releases/download/v$VER/$SETUP',
  signature: sig,
};
try {
  const decoded = Buffer.from(sig, 'base64').toString('utf8');
  const tsMatch = decoded.match(/timestamp:(\\d+)/);
  if (tsMatch) {
    const ageMin = Math.floor((Date.now() - parseInt(tsMatch[1], 10) * 1000) / 60000);
    if (ageMin > 60) {
      throw new Error('latest.json 签名陈旧：windows-x86_64 的 signature timestamp 早于当前 ' + ageMin + ' 分钟（>60 分钟），验签必失败。');
    }
    console.log('  ✅ windows-x86_64 签名新鲜度: ' + ageMin + ' 分钟前');
  }
} catch (e) {
  if (e.message.startsWith('latest.json')) throw e;
  console.warn('  ⚠️ windows-x86_64 签名时间戳解析失败（格式异常）:', e.message);
}
const pendingPath = 'release/PENDING-PLATFORMS.txt';
const pending = new Set();
if (fs.existsSync(pendingPath)) {
  for (const line of fs.readFileSync(pendingPath, 'utf8').split('\\n')) {
    const m = line.match(/^\\[ \\] (\\S+)/);
    if (m) pending.add(m[1]);
  }
}
for (const [key, entry] of Object.entries(manifest.platforms)) {
  const urlVersion = (entry.url.match(/\\/v(\\d+\\.\\d+\\.\\d+)\\//) || [])[1];
  if (urlVersion && urlVersion !== manifest.version) {
    delete manifest.platforms[key];
    pending.add(key + ' (was v' + urlVersion + ', need v' + manifest.version + ')');
    console.warn('  ✂ 剪除 ' + key + ' 旧条目 v' + urlVersion + '——已记入 release/PENDING-PLATFORMS.txt');
    continue;
  }
  if (key === 'windows-x86_64') pending.delete(key);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
if (pending.size > 0) {
  fs.mkdirSync('release', { recursive: true });
  fs.writeFileSync(pendingPath, [...pending].map(p => '[ ] ' + p).join('\\n') + '\\n');
  console.log('  ⚠️  发版待办（release/PENDING-PLATFORMS.txt）：' + [...pending].join('；'));
} else if (fs.existsSync(pendingPath)) {
  fs.unlinkSync(pendingPath);
  console.log('  ✅ 待补平台清零，已删除 release/PENDING-PLATFORMS.txt');
}
console.log('  ✅ 更新 latest.json windows-x86_64 条目');
"

# 6b. latest.json 随构建提交（同 mac/win 两侧约定）
if ! git diff --quiet -- latest.json 2>/dev/null; then
  if git ls-files -u | grep -q .; then
    echo "⚠️  存在未解决合并冲突，latest.json 未自动提交——请解决后手工提交！"
  elif git add latest.json && git commit -m "chore: latest.json v${VER} windows-x86_64 entry" > /dev/null; then
    echo "✅ latest.json 已提交（windows 条目）"
  else
    echo "⚠️  latest.json 自动提交失败——请手工 git add latest.json && git commit"
  fi
fi

echo ""
echo "=== 跨打完成 ==="
ls -lh release/ 2>/dev/null || echo "release/ 目录为空"
echo "产物在: $(pwd)/release/"
echo ""
echo "注意: 本流程不出 MSI（WiX 仅 Windows 可用）；如需 MSI 请在 Windows 宿主跑"
echo "      build-windows-release.sh 补打。Authenticode 未配置时产物未签名，"
echo "      分发前确认这是预期（TIANSHU_ALLOW_UNSIGNED=1）。"
echo ""
echo "发布步骤（同 build-windows-release.sh）:"
echo "  1. 把 release/${SETUP}、release/${SETUP_SIG} 上传到 GitHub Release v${VER}"
echo "  2. gh release upload v$VER latest.json --clobber"
echo "  3. 全平台条目齐后，经 sync 流程更新公开仓 main 的 latest.json"
echo "  4. 同步国内 OSS 更新源：OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=yyy bash scripts/upload-update-to-oss.sh"
