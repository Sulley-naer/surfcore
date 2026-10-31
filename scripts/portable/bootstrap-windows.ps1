<#
  跨设备迁移 —— Windows 目标机一键重建脚本（幂等，可重复运行）。
  用法（在解压好的导出包目录旁运行）：
    powershell -ExecutionPolicy Bypass -File bootstrap-windows.ps1 -Package <导出包目录>
  可选参数：
    -RepoDir     代码仓目录（默认 D:\surfcore\repo）
    -RuntimeBase 运行时目录（默认 E:\DeepSeeK，放 SnowLuma / faster-whisper / ffmpeg）
    -Voice       none | refs | all（必须与导出时的 --voice 一致，默认 none）
    -SkipVoice   -SkipAsr   -SkipSnowluma   跳过对应重建
  说明：脚本只重建「运行时」；「数据」从导出包恢复，「密钥」由你手动填。
  需要手动处理的敏感项，脚本会打印 【手动】 块，不会代你瞎填。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Package,
  [string]$RepoDir = 'D:\surfcore\repo',
  [string]$RuntimeBase = 'E:\DeepSeeK',
  [ValidateSet('none','refs','all')][string]$Voice = 'none',
  [switch]$SkipVoice,
  [switch]$SkipAsr,
  [switch]$SkipSnowluma
)

$ErrorActionPreference = 'Continue'
$DshHome = Join-Path $env:USERPROFILE '.dsh'
$SurfcoreHome = Join-Path $DshHome 'surfcore'
$GitRemote = 'https://github.com/Sulley-naer/surfcore'   # 你的 fork（含语音转写 + 可移植改动）
$GitBranch = 'feat/portable'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function OK($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function WARN($m) { Write-Host "    [手动] $m" -ForegroundColor Yellow }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

if (-not (Test-Path $Package)) { Write-Host "导出包目录不存在：$Package"; exit 1 }
$Manifest = Join-Path $Package 'manifest.json'
if (Test-Path $Manifest) { $Man = Get-Content $Manifest -Raw | ConvertFrom-Json } else { $Man = $null }

# ── 1. 基础工具 ──
Step '检查/安装基础工具（git / node / python / ffmpeg）'
foreach ($c in @('git','node','python')) {
  if (Have $c) { OK "$c 已就绪" }
  else {
    $pkg = switch ($c) { 'git' {'Git.Git'} 'node' {'OpenJS.NodeJS.LTS'} 'python' {'Python.Python.3.12'} }
    WARN "缺少 $c，正在 winget 安装 $pkg"
    winget install -e --id $pkg --accept-source-agreements --accept-package-agreements
  }
}
if (Have 'ffmpeg') { OK 'ffmpeg 已就绪' } else { WARN '缺少 ffmpeg，正在 winget 安装'; winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements }

# ── 2. 代码仓 ──
Step '准备代码仓（clone 或更新）'
if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
  git clone -b $GitBranch $GitRemote $RepoDir
  OK "已 clone $GitRemote ($GitBranch)"
} else {
  git -C $RepoDir fetch origin; git -C $RepoDir checkout $GitBranch 2>$null
  OK '已更新代码仓'
}

# ── 3. 恢复数据 ──
Step '恢复数据（state 与合体层）'
$pState = Join-Path $Package 'surfcore'
$pHome  = Join-Path $Package 'surfcore-home'
if (Test-Path $pState) {
  Copy-Item -Path (Join-Path $pState '*') -Destination (Join-Path $RepoDir 'state') -Recurse -Force
  OK '已恢复 repo/state'
}
if (Test-Path $pHome) {
  New-Item -ItemType Directory -Force -Path $SurfcoreHome | Out-Null
  Copy-Item -Path (Join-Path $pHome '*') -Destination $SurfcoreHome -Recurse -Force
  OK "已恢复 $SurfcoreHome"
}

# ── 4. 模板与 paths.json ──
Step '生成配置模板'
$tplDir = Join-Path $Package 'templates'
if (Test-Path (Join-Path $tplDir 'config.example.json')) {
  if (-not (Test-Path (Join-Path $RepoDir 'config.json'))) {
    Copy-Item (Join-Path $tplDir 'config.example.json') (Join-Path $RepoDir 'config.json')
    WARN "已生成 config.json（来自模板）—— 请手动填入 consoleToken / accessToken / admin.qq / ownerQQ / allow 白名单"
  }
}
if (Test-Path (Join-Path $tplDir 'paths.example.json')) {
  if (-not (Test-Path (Join-Path $RepoDir 'paths.json'))) {
    Copy-Item (Join-Path $tplDir 'paths.example.json') (Join-Path $RepoDir 'paths.json')
    WARN "已生成 paths.json —— 请把本机真实路径填进去（SnowLuma / ffmpeg / faster-whisper），或导出前用 paths.json 里的原值"
  }
}

# ── 5. npm 与插件 ──
Step '安装依赖并挂载 DSH 插件'
Push-Location $RepoDir
npm install
node scripts/setup-dsh.mjs
Pop-Location
OK 'npm install + setup-dsh 完成'
WARN "如果 setup-dsh 没挂上插件，手动跑：dsh plugin --profile desktop install"

# ── 6. 语音包（可选）──
if ($Voice -ne 'none' -and -not $SkipVoice) {
  Step "重建语音包 venv（voice=$Voice）"
  $vp = Join-Path $RepoDir 'state\voice-packs\voice-local'
  if (-not (Test-Path $vp)) { WARN "导出包里没有 voice-packs，跳过" }
  else {
    foreach ($v in @('.venv','.venv-gsv')) {
      $venv = Join-Path $vp $v
      if (Test-Path (Join-Path $venv 'Scripts\python.exe')) { OK "$v 已存在" ; continue }
      WARN "创建 $v（Python 3.12）并安装依赖，可能耗时 10+ 分钟"
      python -m venv $venv
      & (Join-Path $venv 'Scripts\python.exe') -m pip install --upgrade pip
    }
    $vx  = Join-Path $vp '.venv\Scripts\python.exe'
    $vgs = Join-Path $vp '.venv-gsv\Scripts\python.exe'
    & $vx  -m pip install -r (Join-Path $vp 'requirements.txt')
    & $vgs -m pip install -r (Join-Path $vp 'requirements-gsv.txt')
    # 语音合成需要 opencc（requirements-gsv.txt 里没有，需手动补）
    & $vgs -m pip install opencc-python-reimplemented
    # pyopenjtalk-prebuilt 无 cp312 wheel，改用可编译的 pyopenjtalk
    & $vgs -m pip install pyopenjtalk
    WARN "若显卡可用：在 .venv-gsv 里重装 CUDA 版 torch（torch==2.5.1+cu121）；否则用 CPU 版"
    if ($Voice -eq 'refs') { WARN "voice=refs 未带权重：需重新下载 GPT-SoVITS 预训练模型到 $vp\vendor\GPT-SoVITS\code\GPT_SoVITS\pretrained_models 与 $vp\models" }
  }
}

# ── 7. 本地 ASR（可选）──
if (-not $SkipAsr) {
  Step '重建本地语音转写（faster-whisper）'
  $fw = Join-Path $RuntimeBase 'faster-whisper'
  if (Test-Path (Join-Path $fw 'stt_server.py')) { OK "faster-whisper 已就绪于 $fw" }
  else {
    WARN "faster-whisper 运行时不在导出包里（它是运行时），请手动搭或从旧机拷贝 scripts："
    WARN "  1) python -m venv $fw\.venv && 装 faster-whisper==1.2.1 ctranslate2==4.8.4 av==15.1.0 pilk opencc-python-reimplemented"
    WARN "  2) 下载模型 Systran/faster-whisper-small 到 $fw\models\small\model.bin（hf-mirror.com）"
    WARN "  3) 拷贝 transcribe.py / stt_server.py（端口 8766）"
  }
}

# ── 8. SnowLuma（可选）──
if (-not $SkipSnowluma) {
  Step 'SnowLuma（OneBot 网关）'
  $sl = Join-Path $RuntimeBase 'SnowLuma-v2.2.1'
  if (Test-Path (Join-Path $sl 'index.mjs')) { OK "SnowLuma 已就绪于 $sl" }
  else {
    WARN "请手动安装 SnowLuma v2.2.1 到 $sl，并把旧机 config/onebot_*.json（含 HTTP/WS 两套 accessToken）搬过来"
    WARN "两套 token 是分开的：HTTP token 填进 repo/config.json 的 snowluma.accessToken；WS token 靠 SnowLuma 自己的 onebot_*.json 自动发现"
  }
}

# ── 9. 体检 ──
Step '运行迁移体检'
if (Test-Path (Join-Path $RepoDir 'scripts\portable\port-doctor.mjs')) {
  node (Join-Path $RepoDir 'scripts\portable\port-doctor.mjs')
} else { WARN 'port-doctor.mjs 不存在，跳过（可稍后手动跑回归 scripts/test-audit.mjs）' }

Write-Host "`n完成。接下来你需要手动做："
Write-Host "  1. 填 repo/config.json 的密钥与白名单（consoleToken/accessToken/admin/ownerQQ/allow）"
Write-Host "  2. 填 repo/paths.json 的本机路径（SnowLuma/ffmpeg/faster-whisper）"
Write-Host "  3. 重启 DSH，让插件与桥接加载新配置"
