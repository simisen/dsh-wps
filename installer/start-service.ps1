# 手动启动本地服务（给「界面提示本地服务没在跑」的人用）
#
# 为什么逻辑在这里、不在 .cmd 里？
#   cmd.exe 按**本机 OEM 代码页**（中文机器是 936）逐字节读批处理文件，
#   写进 .cmd 的 UTF-8 中文会显示成一堆乱码；带 BOM 还会让第一行报错。
#   PowerShell 能正确识别 UTF-8 BOM，所以中文提示一律放这边，
#   .cmd 只留纯 ASCII 的一行转发。

$ErrorActionPreference = 'Continue'

function Say ($msg, $color = 'Gray') {
    Write-Host $msg -ForegroundColor $color
}

$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$server = Join-Path $root 'server\index.mjs'
$dataDir = Join-Path $env:APPDATA 'dsh-wps'
$port = if ($env:DSH_WPS_PORT) { $env:DSH_WPS_PORT } else { '43130' }

if (-not $env:DSH_WPS_LOG) { $env:DSH_WPS_LOG = Join-Path $dataDir 'service.log' }

Write-Host ''
Say '  助手后台服务' 'Cyan'
Say '  ============================================' 'DarkGray'
Write-Host ''

if (-not (Test-Path $server)) {
    Say '  [找不到服务程序]' 'Red'
    Write-Host ''
    Say "  期望的位置：$server"
    Say '  请回到助手文件夹，双击【点我启动助手】重新安装一次。'
    Write-Host ''
    return 1
}

# 找 Node：先用安装时下载的便携运行时，再找系统里装的
$nodeExe = $null
$cands = @(
    (Join-Path $dataDir 'runtime\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
foreach ($c in $cands) { if (Test-Path $c) { $nodeExe = $c; break } }
if (-not $nodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source }
}

if (-not $nodeExe) {
    Say '  [没找到运行环境]' 'Red'
    Write-Host ''
    Say '  请回到助手文件夹，双击【点我启动助手】重新安装一次。'
    Write-Host ''
    return 1
}

Say "  运行环境： $nodeExe"
Say "  服务地址： http://127.0.0.1:$port/"
Say "  日志文件： $env:DSH_WPS_LOG"
Write-Host ''
Say '  这个窗口请留着不要关，关了助手就用不了了。' 'Yellow'
Say '  想停止服务，直接关掉这个窗口即可。' 'Yellow'
Write-Host ''

& $nodeExe $server --verbose

Write-Host ''
Say '  服务已停止。按任意键关闭窗口。'
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Read-Host | Out-Null }
return 0
