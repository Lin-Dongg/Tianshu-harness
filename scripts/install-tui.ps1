# 天枢（Tianshu）CLI 一键安装 + 启动（Windows PowerShell 5.1+ / PowerShell 7）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1             # 安装 + 启动
#   powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch  # 只安装
#
# 远程一键（irm | iex）。不要加回脚本级 param()：Invoke-Expression 在当前作用域
# 执行文本，param 会被当成命令名，整段在那一行停住。
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/Tianshu-harness/main/scripts/install-tui.ps1 | iex"
#
# 说明：
#   - 官方 npm 包 tianshu-harness，主命令 tianshu（rivet 为兼容别名）；需要 Node.js >= 24（engines 钉死）。
#   - 默认走 npmmirror 镜像（国内网络加速）；设 NPM_CONFIG_REGISTRY 可覆盖。
#   - 幂等：重复执行覆盖升级到最新版。
#   - -NoLaunch 只在 -File 本地跑时从 $args 读取。远程 iex 不带参数，装完即启动。

$ErrorActionPreference = "Stop"
# -File 时 -NoLaunch 落在 $args。iex 远程一键不带参数，$args 为空，默认安装后启动。
$NoLaunch = @($args) -contains '-NoLaunch' -or @($args) -contains '--no-launch'
$Registry = if ($env:NPM_CONFIG_REGISTRY) { $env:NPM_CONFIG_REGISTRY } else { "https://registry.npmmirror.com" }
# npm 经环境变量读 registry（大小写两份都设，与 install-tui.sh 同口径）
$env:NPM_CONFIG_REGISTRY = $Registry
$env:npm_config_registry = $Registry

function Say([string]$Text) { Write-Host "== $Text ==" -ForegroundColor Cyan }
function Die([string]$Text) { Write-Host "x $Text" -ForegroundColor Red; exit 1 }

# 1. Node.js >= 24
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "缺少 Node.js（>= 24）。请先安装：https://nodejs.org/"
}
$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -lt 24) {
  Die "Node.js 版本过低（$(node -v)，需要 >= 24）。请升级后重跑。"
}

# 1.6 npm 全局目录可写性预检。
#     Node 若由系统级安装包落在受保护位置（如 Program Files），普通用户
#     npm install -g 会失败（EACCES/EPERM）。提前给出结论与修法，而不是把它
#     误诊成网络问题。必须排在旧包迁移之前——那一步的 npm uninstall -g 同样要写全局目录。
$NpmPrefix = (& npm prefix -g 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -eq 0 -and $NpmPrefix) {
  $ProbeDir = Join-Path $NpmPrefix "lib\node_modules"
  if (-not (Test-Path $ProbeDir)) { $ProbeDir = $NpmPrefix }
  $Writable = $false
  try {
    $ProbeFile = Join-Path $ProbeDir (".tianshu-wtest-" + [System.Guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllText($ProbeFile, "")
    Remove-Item $ProbeFile -Force -ErrorAction SilentlyContinue
    $Writable = $true
  } catch { $Writable = $false }
  if (-not $Writable) {
    Die "npm 全局目录不可写：$ProbeDir —— npm install -g 会因权限不足失败。修法：改用用户级 prefix「npm config set prefix `"$env:APPDATA\npm`"」后重开终端；或改用 nvm-windows / fnm / volta 安装 Node。详见 docs/guides/troubleshooting.md 第 12 节。"
  }
}

# 2. 改名迁移：旧包 tianshu-tui 若仍全局安装，它的 rivet bin 链接会让
#    npm install -g tianshu-harness 直接 EEXIST——先卸旧包装新包。
npm ls -g --depth=0 tianshu-tui 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Say "检测到旧包 tianshu-tui（已更名为 tianshu-harness）——先卸载再安装"
  npm uninstall -g tianshu-tui
  if ($LASTEXITCODE -ne 0) { Die "卸载旧包 tianshu-tui 失败——请手动执行：npm uninstall -g tianshu-tui; npm install -g tianshu-harness" }
}

# 3. 全局安装（幂等：重复执行覆盖升级）
Say "安装天枢 CLI tianshu-harness（registry=$Registry）"
npm install -g tianshu-harness
if ($LASTEXITCODE -ne 0) {
  Die "安装失败（exit $LASTEXITCODE）。可换官方源：`$env:NPM_CONFIG_REGISTRY='https://registry.npmjs.org' 后重跑"
}

# 3. 验证 + 启动（装 Node 时开着的旧终端拿不到新 PATH——新开终端即可，沿用 README 口径）
if ($NoLaunch) {
  Write-Host ""
  Write-Host "安装完成。下一步（新开一个终端）："
  Write-Host "  tianshu              # 启动（任意目录，进入会话；rivet 别名同效）"
  Write-Host "  tianshu --version    # 查看版本"
  Write-Host ""
  Write-Host "首次使用：启动后输入 /connect 走供应商连接向导配置 API Key，或 setx DEEPSEEK_API_KEY sk-*** 后新开终端。"
  Write-Host "桌面端安装包（macOS 双架构 / Windows）：https://github.com/huiliyi37/Tianshu-harness/releases"
  exit 0
}
Say "启动天枢 tianshu"
tianshu
