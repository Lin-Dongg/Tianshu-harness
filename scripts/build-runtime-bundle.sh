#!/usr/bin/env bash
# build-runtime-bundle.sh — 打插件端自包含运行时包（E2 ②级）
#
# 产物: out/tianshu-runtime-<ver>-<platform>-<arch>.tar.gz (+ .sha256)
# 布局:
#   tianshu-runtime-<ver>-<platform>-<arch>/
#     bin/rivet[.cmd]   启动 shim（exec node dist/cli/entry.js；内置 V8 编译缓存
#                        与 CLI 早期路由，未命中子命令才加载 main.js）
#     node/             自带 Node 运行时（scripts/fetch-node-runtime.js，含 npm）
#     dist/             内核 bundle（含 dist/node_modules 不可内联依赖 + dist/native）
#     version.txt
#
# 只为「宿主平台」出包——CI matrix 按 OS 各跑一次。
# 用法: bash scripts/build-runtime-bundle.sh [--skip-build]
#
# 发布: 产物挂 GitHub Release（tag: runtime-v<ver>），CF Worker 镜像自动代理
# （scripts/cloudflare-update-worker 白名单已含 tianshu-runtime-*）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
NAME="tianshu-runtime-${VERSION}-${PLATFORM}-${ARCH}"
OUT_DIR="$ROOT/out"
STAGE="$OUT_DIR/$NAME"

echo "=== 构建运行时包 $NAME ==="

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "--- npm run build ---"
  npm run build
fi
if [[ ! -f "$ROOT/dist/cli/entry.js" ]]; then
  echo "✗ dist/cli/entry.js 不存在（先 npm run build）" >&2
  exit 1
fi

echo "--- 打包原生依赖（better-sqlite3 → dist/native）---"
node scripts/pack-native.js

echo "--- 暂存不可内联依赖（dist/node_modules）---"
node scripts/stage-runtime-deps.js

echo "--- 拉取自带 Node 运行时 ---"
NODE_RES_DIR="$OUT_DIR/node-runtime"
node scripts/fetch-node-runtime.js "$NODE_RES_DIR"
# fetch-node-runtime 落在 <platform-token>-<arch>/（win32 → win）
NODE_TOKEN="$PLATFORM"
[[ "$PLATFORM" == "win32" ]] && NODE_TOKEN="win"
NODE_SRC="$NODE_RES_DIR/${NODE_TOKEN}-${ARCH}"
if [[ ! -d "$NODE_SRC" ]]; then
  echo "✗ 未找到 Node 运行时目录 $NODE_SRC" >&2
  exit 1
fi

echo "--- 组装 staging ---"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$NODE_SRC" "$STAGE/node"
echo "$VERSION" > "$STAGE/version.txt"

if [[ "$PLATFORM" == "win32" ]]; then
  cat > "$STAGE/bin/rivet.cmd" <<'EOF'
@echo off
"%~dp0..\node\node.exe" "%~dp0..\dist\cli\entry.js" %*
EOF
else
  cat > "$STAGE/bin/rivet" <<'EOF'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node/node" "$DIR/dist/cli/entry.js" "$@"
EOF
  chmod +x "$STAGE/bin/rivet"
fi

echo "--- 压缩 + 校验和 ---"
mkdir -p "$OUT_DIR"
tar -czf "$OUT_DIR/$NAME.tar.gz" -C "$OUT_DIR" "$NAME"
if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
else
  (cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
fi
rm -rf "$STAGE"

SIZE=$(du -h "$OUT_DIR/$NAME.tar.gz" | cut -f1)
echo ""
echo "=== 完成 ==="
echo "  $OUT_DIR/$NAME.tar.gz ($SIZE)"
echo "  $OUT_DIR/$NAME.tar.gz.sha256"
echo ""
echo "发布: gh release upload runtime-v$VERSION out/$NAME.tar.gz out/$NAME.tar.gz.sha256"
