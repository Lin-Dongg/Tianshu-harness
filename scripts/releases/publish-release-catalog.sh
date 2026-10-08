#!/usr/bin/env bash
# publish-release-catalog.sh — 发布收口：把 release-catalog.json 推到 GitHub release + OSS
#
# 为什么存在：桌面端 3.29.0 起更新走「release catalog」路由（desktop/src-tauri/src/
# update_routing.rs）。catalog 由 generate-catalog.mjs 生成、由 publish-routing.mjs
# 发布——两步都是手动的，历史上漏过：3.29.1 的 catalog 生成并提交进了仓库，却从未
# 发布到线上（OSS / Tianshu-harness release 双 404），于是客户端 catalog 拉取失败、
# 静默降级为 GitHub-only，国内源整体失效。本脚本把「发布后收口」固化为一步，并在
# 动手前后做前置/后置对账，防再漏。
#
# 用法：
#   bash scripts/releases/publish-release-catalog.sh            # 默认 dry run：只做前置检查 + 本地生成 catalog
#   bash scripts/releases/publish-release-catalog.sh --publish  # 真发布（对外、不可逆：OSS 覆盖 + release --clobber）
#
# 选项：
#   --publish        执行对外发布（upload-to-oss + publish-routing --publish + 线上验证）
#   --skip-oss       跳过 upload-update-to-oss.sh（OSS 二进制/legacy manifest 已单独传过）
#   --no-commit      generate-catalog 后不自动提交 release-catalog.json
#   --website DIR    覆盖 website checkout 路径（默认 ../tianshu-website）
#
# 前置（脚本逐条校验，缺一即 fail-closed 退出）：
#   1. latest.json 的 version = 待发布版本
#   2. docs/releases/summaries/<ver>.json 存在且通过 validateReleaseNotes
#      （generate-catalog 靠它生成 releaseNotesUrl；缺了会继承旧版本路径 → 校验失败）
#   3. GitHub release v<ver> 已建，且 manifest 引用的每个平台资产都在
#   4. website checkout 存在（publish-routing --website 需要）
set -euo pipefail
cd "$(dirname "$0")/../.."

PUBLISH=0; SKIP_OSS=0; NO_COMMIT=0; WEBSITE="../tianshu-website"
while [ $# -gt 0 ]; do
  case "$1" in
    --publish)    PUBLISH=1; shift ;;
    --skip-oss)   SKIP_OSS=1; shift ;;
    --no-commit)  NO_COMMIT=1; shift ;;
    --website)    WEBSITE="${2:-}"; shift 2 ;;
    --website=*)  WEBSITE="${1#*=}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

REPO="huiliyi37/Tianshu-harness"
fail() { echo "✗ $*" >&2; exit 1; }
step() { echo ""; echo "==> $*"; }

VER="$(node -p "require('./latest.json').version" 2>/dev/null || true)"
[ -n "$VER" ] || fail "读取不到 latest.json 的 version"
echo "发布版本：v$VER"

step "前置检查 1/4：发布说明摘要"
SUM="docs/releases/summaries/${VER}.json"
[ -f "$SUM" ] || fail "缺少 $SUM —— generate-catalog 需要它生成 releaseNotesUrl（缺了会继承旧版本路径并校验失败）。先补该文件。"
node --input-type=module -e "
import { validateReleaseNotes } from './scripts/releases/release-notes.mjs';
import { readFileSync } from 'node:fs';
validateReleaseNotes(JSON.parse(readFileSync(process.argv[1],'utf8')), process.argv[2]);
" "$SUM" "$VER" || fail "$SUM 未通过 validateReleaseNotes"
echo "    $SUM ✓"

step "前置检查 2/4：GitHub release 存在"
gh release view "v$VER" --repo "$REPO" >/dev/null 2>&1 \
  || fail "GitHub release v$VER 不存在或不可访问——generate-catalog 会报 metadata 404。先建 release 并传齐资产。"
echo "    v$VER ✓"

step "前置检查 3/4：manifest 引用的资产齐备"
ASSETS="$(gh release view "v$VER" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null || true)"
[ -n "$ASSETS" ] || fail "拉不到 v$VER 的资产清单（gh 权限或网络）"
MISSING="$(printf '%s\n' "$ASSETS" | node -e "
const m = require('./latest.json');
const have = new Set(require('fs').readFileSync(0,'utf8').split('\n').map(s => s.trim()).filter(Boolean));
for (const p of Object.values(m.platforms)) { const f = p.url.split('/').pop(); if (!have.has(f)) console.log(f); }
")"
[ -z "$MISSING" ] || fail "release v$VER 缺少 manifest 引用的资产：$(echo "$MISSING" | tr '\n' ' ')"
echo "    资产齐备（$(printf '%s\n' "$ASSETS" | grep -c '^Tianshu_' || true) 个 Tianshu_* 对象）✓"

step "前置检查 4/4：website checkout"
[ -d "$WEBSITE" ] || fail "website checkout 不存在：$WEBSITE（publish-routing --website 需要）。用 --website 指定。"
echo "    $WEBSITE ✓"

step "1/4 OSS 二进制 + legacy latest.json"
if [ "$SKIP_OSS" = 1 ]; then
  echo "    跳过（--skip-oss）"
else
  OSS_ASSET_DIR=release bash scripts/upload-update-to-oss.sh
fi

step "2/4 生成 release-catalog.json"
node scripts/releases/generate-catalog.mjs

step "3/4 提交 release-catalog.json"
if [ "$NO_COMMIT" = 1 ]; then
  echo "    跳过（--no-commit）"
elif [ -n "$(git status --porcelain -- release-catalog.json)" ]; then
  git commit -m "chore(release): release-catalog v$VER" -- release-catalog.json
else
  echo "    无变化，跳过"
fi

if [ "$PUBLISH" != 1 ]; then
  echo ""
  echo "DRY RUN：catalog 已在本地生成，未对外发布。加 --publish 执行对外发布。"
  exit 0
fi

step "4/4 发布 catalog 到 GitHub release + OSS"
node scripts/releases/publish-routing.mjs --publish --release-notes-reviewed --website "$WEBSITE"

step "后置验证：两条 catalog URL 应返回 v$VER"
rc=0
check() {
  local url="$1" label="$2" got
  got="$(curl -sSL -m 20 "$url" 2>/dev/null | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo FAIL)"
  printf '    %-7s %s\n' "$label" "$got"
  [ "$got" = "$VER" ] || { echo "    ✗ $label 未返回 v$VER"; rc=1; }
}
check "https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/release-catalog.json" "OSS"
check "https://github.com/$REPO/releases/latest/download/release-catalog.json" "GitHub"
[ "$rc" = 0 ] || fail "线上 catalog 校验未通过——检查 OSS/GitHub 权限与 CDN"
echo ""
echo "✅ v$VER 发布收口完成：国内源自更新路由已生效。"
