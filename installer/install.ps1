#Requires -Version 5.1
<#
  安装 DSH × WPS。

  做四件事：
    1. 找到 Node 运行时（找不到就给明确指引，不静默失败）
    2. 在 WPS 的加载项目录写 publish.xml，注册文字/表格/演示三个组件
    3. 可选：注册开机自启（让本地服务常驻）
    4. 立刻把服务拉起来

  为什么必须注册自启：
    WPS 对加载项做了进程沙箱，加载项自己**无法**启动本地服务
    （实测 CoCreateInstance('WScript.Shell') 报 "can not create"）。
    所以服务只能由外部拉起。
#>
param(
  [switch]$NoAutostart,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Head($msg) { Write-Host ''; Write-Host "  $msg" -ForegroundColor Cyan; Write-Host ('  ' + ('-' * 60)) -ForegroundColor DarkGray }

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverJs    = Join-Path $projectRoot 'server\index.mjs'
$port        = if ($env:DSH_WPS_PORT) { $env:DSH_WPS_PORT } else { '43130' }
$url         = "http://127.0.0.1:$port/"
$dataDir     = Join-Path $env:APPDATA 'dsh-wps'

Say ''
Say '  DSH x WPS  -  安装程序' 'White'
Say '  ============================================================' 'DarkGray'

# ---------- 1. 找 Node（找不到就自己下一个便携运行时）----------
Head '1/4  准备 Node 运行时'

$runtimeDir  = Join-Path $dataDir 'runtime'
$runtimeNode = Join-Path $runtimeDir 'node.exe'

function Find-SystemNode {
  # 只认真正的 node.exe —— node.cmd 之类的 shim 不适合当常驻服务运行时
  $cands = New-Object System.Collections.ArrayList
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { [void]$cands.Add($cmd.Source) }
  [void]$cands.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  if (${env:ProgramFiles(x86)}) { [void]$cands.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')) }
  [void]$cands.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
  [void]$cands.Add((Join-Path $env:LOCALAPPDATA 'nvs\node.exe'))
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

<#
  下载一个便携版 Node，解到 %APPDATA%\dsh-wps\runtime\。
  这样接收者**不需要自己装 Node** —— 这是"能分享给别人用"的关键一步。

  为什么用 curl.exe 而不是 Invoke-WebRequest：
  实测这个环境里 PowerShell 的 Invoke-WebRequest 连不上外网（TLS 被拦），
  而 curl.exe（Win10 1803+ 自带）正常。而且 curl 自带进度条，34MB 下载不至于让人以为卡死。
#>
function Get-PortableNode {
  param([string]$Dir)

  if (Test-Path $runtimeNode) { return $runtimeNode }

  $indexes = @(
    'https://registry.npmmirror.com/-/binary/node/latest-v24.x/',
    'https://registry.npmmirror.com/-/binary/node/latest-v22.x/',
    'https://nodejs.org/dist/latest-v24.x/'
  )

  $zipUrl = $null
  $zipName = $null
  foreach ($idx in $indexes) {
    try {
      $raw = & curl.exe -s -m 25 $idx 2>$null | Out-String
      if (-not $raw) { continue }
      $arr = $raw | ConvertFrom-Json
      $pick = $arr | Where-Object { $_.name -like '*win-x64.zip' } |
              Sort-Object { [datetime]$_.date } -Descending | Select-Object -First 1
      if ($pick) { $zipUrl = $pick.url; $zipName = $pick.name; break }
    } catch { continue }
  }
  if (-not $zipUrl) { return $null }

  Say ("  没找到 Node，正在下载便携运行时（约 35 MB，只下这一次）：") 'DarkGray'
  Say ("    $zipName") 'DarkGray'

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $zip = Join-Path $Dir 'node-download.zip'
  & curl.exe -L --fail -m 900 -o $zip $zipUrl
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zip)) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    return $null
  }

  Say '  正在解压…' 'DarkGray'
  & tar.exe -xf $zip -C $Dir
  Remove-Item $zip -Force -ErrorAction SilentlyContinue

  # 压缩包里是 node-vXX-win-x64/ 这样的子目录，把内容提上来再删掉空壳
  $sub = Get-ChildItem $Dir -Directory -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
  if ($sub) {
    Get-ChildItem $sub.FullName -Force | ForEach-Object {
      Move-Item -LiteralPath $_.FullName -Destination $Dir -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $sub.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }

  # 只留 node.exe 和它的 LICENSE。
  # npm / npx / corepack / CHANGELOG 这些我们用不上，留着白占约 9MB 和一堆文件。
  # （node.exe 是自包含的，实测单独一个文件就能把服务跑起来。）
  Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notin @('node.exe', 'LICENSE') } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  if (Test-Path $runtimeNode) { return $runtimeNode }
  return $null
}

$nodeExe = $null
$nodeFrom = ''

if (Test-Path $runtimeNode) {
  $nodeExe = $runtimeNode
  $nodeFrom = '便携运行时（之前装好的）'
} else {
  $sys = Find-SystemNode
  if ($sys) { $nodeExe = $sys; $nodeFrom = '系统已安装' }
}

if (-not $nodeExe) {
  $portable = Get-PortableNode -Dir $runtimeDir
  if ($portable) { $nodeExe = $portable; $nodeFrom = '刚下载的便携运行时' }
}

if (-not $nodeExe) {
  Say '  [X] 没找到 Node，自动下载也失败了。' 'Red'
  Say ''
  Say '      多半是网络问题。两个办法：' 'Yellow'
  Say '        1. 连上能访问外网的环境后重新运行 点我启动助手.cmd' 'Yellow'
  Say '        2. 自己装一个 Node.js 18+： https://nodejs.org/' 'Yellow'
  Say '           装完再运行 点我启动助手.cmd 即可（会自动识别）' 'Yellow'
  Say ''
  exit 1
}

Say "  [OK] Node: $nodeExe" 'Green'
Say "       来源: $nodeFrom" 'DarkGray'

if (-not (Test-Path $serverJs)) {
  Say "  [X] 找不到服务文件：$serverJs" 'Red'
  Say '      请确认 点我启动助手.cmd 是在项目根目录里运行的。' 'Yellow'
  exit 1
}

# ---------- 2. 注册 WPS 加载项 ----------
Head '2/4  注册 WPS 加载项'

$jsaddons = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$pubXml   = Join-Path $jsaddons 'publish.xml'
New-Item -ItemType Directory -Force -Path $jsaddons | Out-Null
Say "  加载项目录: $jsaddons"

# 已有配置先备份，绝不覆盖别人写的东西
if (Test-Path $pubXml) {
  $backup = "$pubXml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $pubXml $backup -Force
  Say "  已备份原 publish.xml -> $(Split-Path -Leaf $backup)" 'DarkGray'
}

[xml]$doc = if (Test-Path $pubXml) { Get-Content $pubXml -Raw -Encoding UTF8 } else { '<jsplugins></jsplugins>' }
if (-not $doc.DocumentElement) { throw 'publish.xml 格式异常，无法解析' }
if ($doc.DocumentElement.Name -ne 'jsplugins') { throw "publish.xml 根节点应该是 jsplugins，实际是 $($doc.DocumentElement.Name)" }

function Set-OnlinePlugin($root, $name, $type, $url) {
  $existing = $root.SelectNodes("jspluginonline[@name='$name']")
  foreach ($e in $existing) { [void]$root.RemoveChild($e) }
  $el = $root.OwnerDocument.CreateElement('jspluginonline')
  foreach ($pair in @(@('name', $name), @('type', $type), @('url', $url), @('debug', ''),
                      @('enable', 'enable_dev'), @('install', 'null'), @('customDomain', ''))) {
    $el.SetAttribute($pair[0], $pair[1])
    # 显式写空字符串属性（XmlDocument 默认会省略空属性）
    if ($pair[1] -eq '' -and -not $el.HasAttribute($pair[0])) { $el.SetAttribute($pair[0], '') }
  }
  [void]$root.AppendChild($el)
}

$root = $doc.DocumentElement
Set-OnlinePlugin $root 'DshWps'    'wps' $url
Set-OnlinePlugin $root 'DshWpsEt'  'et'  $url
Set-OnlinePlugin $root 'DshWpsWpp' 'wpp' $url

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = New-Object System.Text.UTF8Encoding($false)
$writer = [System.Xml.XmlWriter]::Create($pubXml, $settings)
$doc.Save($writer)
$writer.Close()
Say '  [OK] 已注册三个组件：文字(wps) / 表格(et) / 演示(wpp)' 'Green'
Say "       指向 $url" 'DarkGray'

# 顺手清掉同名残留（历史遗留的在线条目）
Say '  提示：如果 WPS 现在开着，需要完全退出再打开才会生效（关窗口不算）。' 'Yellow'

# ---------- 3. 开机自启 ----------
Head '3/4  注册开机自启'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$vbs    = Join-Path $dataDir 'start-hidden.vbs'

if ($NoAutostart) {
  Say '  已跳过（-NoAutostart）' 'DarkGray'
} else {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

  # 启动器分两层，这是实测踩出来的坑：
  #   WScript.Shell.Run 里直接拼 `cmd /c "a.cmd" "b.js"` 会被 cmd 自己的引号规则吃掉首尾引号，
  #   命令静默失效、服务根本起不来（真实发生过）。
  #   改成「一个 .cmd 包装脚本 + 一个只负责隐藏窗口的 .vbs」。
  #   包装脚本顺便把输出写进 service.log —— 窗口是隐藏的，出问题只能靠日志查。
  #
  # ⚠️ 注意下面每一条拼接都必须用括号包住：
  #   PowerShell 里逗号的优先级 **高于** 加号，`@('a', 'b' + $x + 'c')` 会被展平成
  #   三个元素 ['a', 'b', $x, 'c']，join 出来就变成多行，路径被拆断。踩过一次。
  $wrapper = Join-Path $dataDir 'start-hidden.cmd'
  $svcLog  = Join-Path $dataDir 'service.log'
  # --verbose 不能省：请求级细节（哪个文件被取走、有没有前端报错、模型请求成没成）
  # 只在 verbose 下才输出，而这里是隐藏窗口，日志就是唯一的排查手段。
  $wrapperBody = @(
    '@echo off',
    'chcp 65001 >nul',
    ('echo. >> "' + $svcLog + '"'),
    ('echo [%DATE% %TIME%] ---- starting ---- >> "' + $svcLog + '"'),
    ('"' + $nodeExe + '" "' + $serverJs + '" --verbose >> "' + $svcLog + '" 2>&1'),
    ('echo [%DATE% %TIME%] ---- exited code=%ERRORLEVEL% ---- >> "' + $svcLog + '"')
  ) -join "`r`n"
  Set-Content -Path $wrapper -Value $wrapperBody -Encoding Default

  $line = 'CreateObject("WScript.Shell").Run """' + $wrapper + '""", 0, False'
  Set-Content -Path $vbs -Value $line -Encoding Unicode

  # 注册自启。某些环境（组策略、安全软件）会拦注册表写入 ——
  # 拦了就降级成"需要手动启动"，不能让整个安装挂掉。
  try {
    Set-ItemProperty -Path $runKey -Name 'DshWpsService' -Value ('wscript.exe "' + $vbs + '"') -Force
    Say '  [OK] 已注册开机自启（登录后自动在后台启动服务）' 'Green'
  } catch {
    Say '  [!] 开机自启注册失败（可能被组策略或安全软件拦了）' 'Yellow'
    Say '      不影响使用，但每次开机需要手动双击【点我修复助手】' 'Yellow'
  }
  Say "       启动器: $vbs" 'DarkGray'
  Say "       服务日志: $svcLog" 'DarkGray'
}

# ---------- 4. 现在就把服务拉起来 ----------
Head '4/4  启动服务'

if ($NoStart) {
  Say '  已跳过（-NoStart）' 'DarkGray'
} else {
  $already = $false
  try {
    $r = Invoke-WebRequest -Uri ($url + 'api/ping') -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $already = $true }
  } catch { $already = $false }

  if ($already) {
    Say '  服务已经在运行了。' 'Green'
  } else {
    if (Test-Path $vbs) {
      Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
    } else {
      Start-Process -FilePath $nodeExe -ArgumentList ('"' + $serverJs + '"') -WindowStyle Minimized
    }
    Start-Sleep -Seconds 3
    try {
      $r = Invoke-WebRequest -Uri ($url + 'api/ping') -TimeoutSec 4 -UseBasicParsing
      if ($r.StatusCode -eq 200) { Say "  [OK] 服务已启动：$url" 'Green' }
      else { Say "  [!] 服务响应异常：HTTP $($r.StatusCode)" 'Yellow' }
    } catch {
      Say '  [!] 服务好像没起来。手动双击【点我修复助手】看看报什么错。' 'Yellow'
    }
  }
}

# ---------- 完成 ----------
Say ''
Say '  ============================================================' 'DarkGray'
Say '  安装完成。' 'White'
Say ''
Say '  接下来：' 'White'
Say '    1. 完全退出 WPS（关掉所有窗口，确认托盘里也没有）'
Say '    2. 重新打开 WPS 文字'
Say '    3. 顶部会多出一个「AI 助手」标签页，点「打开助手」'
Say '    4. 右侧栏会让你填 API Key —— 填你自己的，直接连厂商'
Say ''
Say "  本地服务地址：$url" 'DarkGray'
Say "  配置文件目录：$dataDir" 'DarkGray'
Say '  卸载：双击【点我卸载助手】' 'DarkGray'
Say ''
