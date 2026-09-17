#Requires -Version 5.1
<#
  卸载 DSH × WPS。
    1. 从 publish.xml 里摘掉我们注册的三个条目（保留别人的条目）
    2. 移除开机自启
    3. 停掉正在运行的服务
  默认保留配置和 API Key；加 -PurgeConfig 才会删。
#>
param(
  [switch]$PurgeConfig
)

$ErrorActionPreference = 'Continue'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Head($msg) { Write-Host ''; Write-Host "  $msg" -ForegroundColor Cyan; Write-Host ('  ' + ('-' * 60)) -ForegroundColor DarkGray }

$dataDir  = Join-Path $env:APPDATA 'dsh-wps'
$jsaddons = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$pubXml   = Join-Path $jsaddons 'publish.xml'
$names    = @('DshWps', 'DshWpsEt', 'DshWpsWpp')
$port     = if ($env:DSH_WPS_PORT) { $env:DSH_WPS_PORT } else { '43130' }

Say ''
Say '  DSH x WPS  -  卸载程序' 'White'
Say '  ============================================================' 'DarkGray'

# ---------- 1. 摘掉加载项注册 ----------
Head '1/3  移除 WPS 加载项注册'

if (Test-Path $pubXml) {
  try {
    [xml]$doc = Get-Content $pubXml -Raw -Encoding UTF8
    $root = $doc.DocumentElement
    $removed = 0
    foreach ($n in $names) {
      $nodes = $root.SelectNodes("jspluginonline[@name='$n']")
      foreach ($node in $nodes) { [void]$root.RemoveChild($node); $removed++ }
    }

    if ($removed -gt 0) {
      $settings = New-Object System.Xml.XmlWriterSettings
      $settings.Indent = $true
      $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
      $writer = [System.Xml.XmlWriter]::Create($pubXml, $settings)
      $doc.Save($writer)
      $writer.Close()
      Say "  [OK] 已移除 $removed 个注册条目" 'Green'

      # 如果整份 publish.xml 已经没有内容了，就把目录也收干净
      $left = $root.SelectNodes('*')
      if ($left.Count -eq 0) {
        Remove-Item $pubXml -Force
        $others = @(Get-ChildItem $jsaddons -Force -ErrorAction SilentlyContinue)
        if ($others.Count -eq 0) { Remove-Item $jsaddons -Recurse -Force -ErrorAction SilentlyContinue }
        Say '  [OK] publish.xml 已空，连目录一起清理了' 'Green'
      }
    } else {
      Say '  publish.xml 里没有我们的条目，跳过' 'DarkGray'
    }
  } catch {
    Say "  [!] 处理 publish.xml 出错：$($_.Exception.Message)" 'Yellow'
    Say '      你可以手动检查这个文件：' 'Yellow'
    Say "      $pubXml" 'DarkGray'
  }
} else {
  Say '  没有找到 publish.xml，跳过' 'DarkGray'
}

# ---------- 2. 移除自启 ----------
Head '2/3  移除开机自启'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
try {
  $existing = Get-ItemProperty -Path $runKey -Name 'DshWpsService' -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-ItemProperty -Path $runKey -Name 'DshWpsService' -Force
    Say '  [OK] 已移除自启项' 'Green'
  } else {
    Say '  没有自启项，跳过' 'DarkGray'
  }
} catch {
  Say "  [!] 移除自启项失败：$($_.Exception.Message)" 'Yellow'
}

$vbs = Join-Path $dataDir 'start-hidden.vbs'
if (Test-Path $vbs) { Remove-Item $vbs -Force; Say '  [OK] 已删除隐藏启动器' 'Green' }
$wrapper = Join-Path $dataDir 'start-hidden.cmd'
if (Test-Path $wrapper) { Remove-Item $wrapper -Force; Say '  [OK] 已删除启动包装脚本' 'Green' }

# ---------- 3. 停掉服务 ----------
Head '3/3  停止本地服务'

$killed = 0
try {
  $conns = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') {
      Stop-Process -Id $p.Id -Force
      $killed++
    }
  }
} catch { }

if ($killed -gt 0) { Say "  [OK] 已停止 $killed 个服务进程" 'Green' }
else { Say '  端口上没有在跑的服务，跳过' 'DarkGray' }

# ---------- 配置数据 ----------
if ($PurgeConfig) {
  Head '附加：清除配置'
  if (Test-Path $dataDir) {
    Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    Say '  [OK] 已删除配置目录（含 API Key）' 'Green'
  } else {
    Say '  没有配置目录' 'DarkGray'
  }
} else {
  if (Test-Path $dataDir) {
    Say ''
    Say "  配置和 API Key 保留在：$dataDir" 'DarkGray'
    Say '  想连 API Key 一起删掉：' 'DarkGray'
    Say '    把【点我卸载助手.cmd】拖进「命令提示符」窗口，' 'DarkGray'
    Say '    在它后面打个空格，再输入 -PurgeConfig，回车。' 'DarkGray'
  }
}

Say ''
Say '  ============================================================' 'DarkGray'
Say '  卸载完成。完全退出并重开 WPS 后，「AI 助手」标签页就会消失。' 'White'
Say ''
