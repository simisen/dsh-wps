# 全新机器模拟测试 —— 验证「解压 → 双击 → 能用」这条链路真的成立。
#
# 为什么要专门做这个：
#   开发机上 node 在 PATH 里、APPDATA 里已经有配置、WPS 也早就注册过 ——
#   所有"新鲜人第一次装"才会踩的坑，在这台机器上**一个都测不出来**。
#   这个脚本把环境剥干净，从解压开始完整走一遍。
#
# 它做的事：
#   1. 把 dist 里的发布包解压到临时目录（不碰你的项目目录）
#   2. 检查中文文件名有没有正确还原、.cmd/.ps1 的编码对不对
#   3. 把含 node 的目录从 PATH 里摘掉，APPDATA 重定向到临时目录（模拟全新机器）
#   4. 双击【点我启动助手】—— 真的会去下载 35 MB 便携 Node
#   5. 验证服务、静态文件、目录穿越防护、publish.xml、运行时
#   6. 停掉服务，用【点我修复助手】手动拉起
#   7. 用【点我卸载助手】卸载，确认清理干净
#
# 用法： node dev/build-release.mjs  然后  powershell -ExecutionPolicy Bypass -File dev/fresh-install-test.ps1
# 加 -Keep 可以保留临时目录，方便出问题时翻现场。
# 注意：会临时改写 HKCU 的开机自启项，结束时自动还原。
param([switch]$Keep)

$ErrorActionPreference = 'Continue'
$proj0  = Split-Path -Parent $PSScriptRoot        # 仓库根目录
$zip    = Join-Path $proj0 'dist\dsh-wps-0.1.0.zip'
$root   = Join-Path $env:TEMP 'dsh-wps-fresh-test'
$app    = Join-Path $root 'appdata'
$local  = Join-Path $root 'localappdata'
$port   = '43135'
$log    = Join-Path $root 'test.log'

New-Item -ItemType Directory -Force -Path $root | Out-Null
function Say($m) { $m | Tee-Object -FilePath $log -Append }

Say "================ 全新机器模拟测试（中文文件名版本）================"
Say ("时间: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ---------- 1. 解压 ----------
Say "`n[1/7] 解压发布包"
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not (Test-Path $zip)) { Say ('  ✘ 找不到发布包，先跑 node dev/build-release.mjs: ' + $zip); exit 1 }
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $root)
$proj = Join-Path $root 'dsh-wps'
if (-not (Test-Path $proj)) { Say "  ✘ 解压后没找到 dsh-wps 目录"; exit 1 }
Say ("  OK  解压到 " + $proj)

# 三个脚本都不写死中文名，靠 zip 里解出来的顺序认 —— 顺便验证中文名确实还原对了
$cmds = Get-ChildItem -Path $proj -Filter '*.cmd' | Sort-Object Name
Say ("  解压出的 .cmd 共 " + $cmds.Count + " 个：")
foreach ($c in $cmds) { Say ("    - " + $c.Name + "  (" + $c.Length + " 字节)") }

$launcher    = $cmds | Where-Object { $_.Name -like '点我启动*' } | Select-Object -First 1
$uninstaller = $cmds | Where-Object { $_.Name -like '点我卸载*' } | Select-Object -First 1
$fixer       = $cmds | Where-Object { $_.Name -like '点我修复*' } | Select-Object -First 1
foreach ($pair in @(@('安装启动脚本',$launcher), @('卸载脚本',$uninstaller), @('修复脚本',$fixer))) {
    if ($pair[1]) { Say ("  OK  " + $pair[0] + ": " + $pair[1].Name) }
    else { Say ("  ✘ 没找到" + $pair[0]); $ok = $false }
}
if (-not $launcher) { exit 1 }

$docs = Get-ChildItem -Path $proj -Filter '*.txt'
foreach ($d in $docs) { Say ("  OK  说明书: " + $d.Name + "  (" + $d.Length + " 字节)") }

# ---------- 2. 编码自检 ----------
Say "`n[2/7] 中文文件名 + 编码自检"
foreach ($c in $cmds) {
    $b = [System.IO.File]::ReadAllBytes($c.FullName)
    $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $nonAscii = @($b | Where-Object { $_ -gt 127 }).Count
    Say ("  " + $(if (-not $bom -and $nonAscii -eq 0) { "OK  " } else { "✘   " }) + $c.Name + "  BOM=$bom  非ASCII字节=$nonAscii")
}
$isAscii = $launcher.Name -match '^[\x20-\x7E]+$'
Say "  启动脚本文件名是纯 ASCII 吗: $isAscii （应为 False，说明中文名确实还原出来了）"
$doc = $docs | Select-Object -First 1
if ($doc) {
    $db = [System.IO.File]::ReadAllBytes($doc.FullName)
    $dbom = ($db.Length -ge 3 -and $db[0] -eq 0xEF -and $db[1] -eq 0xBB -and $db[2] -eq 0xBF)
    Say ("  " + $(if ($dbom) { "OK  " } else { "✘   " }) + $doc.Name + " 带 UTF-8 BOM（记事本才不乱码）")
}

# ---------- 3. 模拟全新机器 ----------
Say "`n[3/7] 准备干净环境（PATH 去掉 node，APPDATA 重定向）"
New-Item -ItemType Directory -Force -Path $app, $local | Out-Null
$env:APPDATA        = $app
$env:LOCALAPPDATA   = $local
$env:DSH_WPS_PORT   = $port
# 只把「含 node 的目录」从 PATH 里摘掉 —— 真实机器上 powershell 还得能找到，
# 否则测出来的失败是测试环境自己造成的，不是产品的问题。
# 变量名故意不叫 $keep：PowerShell 变量名**不区分大小写**，
# $keep 会和 -Keep 开关是同一个东西，`+=` 直接炸，PATH 被写成空值，
# 后面连 cmd.exe 都找不到了（这个坑真踩过）。
$pathKeep = @()
$dropped = @()
foreach ($d in ($env:PATH -split ';')) {
    if (-not $d) { continue }
    if ((Test-Path (Join-Path $d 'node.exe')) -or (Test-Path (Join-Path $d 'node.cmd')) -or (Test-Path (Join-Path $d 'node.bat'))) {
        $dropped += $d
    } else { $pathKeep += $d }
}
$env:PATH = ($pathKeep -join ';')
Say ("  APPDATA   = " + $app)
Say ("  PORT      = " + $port)
foreach ($d in $dropped) { Say ("  已从 PATH 摘掉含 node 的目录: " + $d) }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
Say ("  PATH 里还能找到 node 吗: " + $(if ($nodeCmd) { "能（不符合干净环境预期）" } else { "不能（符合预期）" }))
$psCmd = Get-Command powershell -ErrorAction SilentlyContinue
Say ("  PATH 里还能找到 powershell 吗: " + $(if ($psCmd) { "能（必要，否则测不准）" } else { "不能 —— 测试环境有问题" }))
$tarCmd = Get-Command tar -ErrorAction SilentlyContinue
Say ("  PATH 里还能找到 tar 吗: " + $(if ($tarCmd) { "能（便携 Node 解压需要它）" } else { "不能" }))

# ---------- 4. 双击启动 ----------
Say "`n[4/7] 执行【点我启动助手】（等同双击）"
# 安装脚本会覆盖 HKCU 里的开机自启项，而注册表不跟着 APPDATA 走 ——
# 先存下来，测完原样还原，别把本机真正的自启配置弄丢了。
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runKeyBackup = (Get-ItemProperty -Path $runKeyPath -Name 'DshWpsService' -ErrorAction SilentlyContinue).DshWpsService
Say ("  已备份开机自启项: " + $(if ($runKeyBackup) { $runKeyBackup } else { '(原本没有)' }))
$t0 = Get-Date
$out = & cmd.exe /c "`"$($launcher.FullName)`" < nul" 2>&1
$el = [int]((Get-Date) - $t0).TotalSeconds
Say ("  退出耗时: ${el}s")
foreach ($line in $out) { Say ("  | " + $line) }

# ---------- 5. 验证 ----------
Say "`n[5/7] 验证安装结果"
Start-Sleep -Seconds 4
$ok = $true
try {
    $ping = Invoke-RestMethod ("http://127.0.0.1:$port/api/ping") -TimeoutSec 8
    Say ("  OK  服务活着: ok=" + $ping.ok)
} catch { Say ("  ✘ 服务不可达: " + $_.Exception.Message); $ok = $false }

$static = @(
  'index.html','main.js','js/api.js','js/bootstrap.js','js/doc.js',
  'ui/chat.html','ui/settings.html','ribbon.xml','manifest.xml'
)
$good = 0
foreach ($f in $static) {
    try {
        $r = Invoke-WebRequest ("http://127.0.0.1:$port/" + $f) -UseBasicParsing -TimeoutSec 8
        if ($r.StatusCode -eq 200) { $good++ } else { Say ("  ✘ " + $f + " -> " + $r.StatusCode); $ok = $false }
    } catch { Say ("  ✘ " + $f + " -> " + $_.Exception.Message); $ok = $false }
}
Say ("  " + $(if ($good -eq $static.Count) { "OK  " } else { "✘   " }) + "静态文件: $good / " + $static.Count + " 个返回 200")

try {
    $r = Invoke-WebRequest ("http://127.0.0.1:$port/../server/store.mjs") -UseBasicParsing -TimeoutSec 8
    Say ("  ✘ 目录穿越没被挡住 -> " + $r.StatusCode); $ok = $false
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    Say ("  OK  目录穿越被挡住 -> " + $code)
}

$pub = Join-Path $app 'kingsoft\wps\jsaddons\publish.xml'
if (Test-Path $pub) {
    $x = Get-Content $pub -Raw -Encoding UTF8
    $hit = $x -match [regex]::Escape("127.0.0.1:$port")
    Say ("  " + $(if ($hit) { "OK" } else { "✘" }) + "  publish.xml 已写入并指向 $port")
    if (-not $hit) { $ok = $false }
    foreach ($id in @('DshWps','DshWpsEt','DshWpsWpp')) {
        if ($x -match $id) { Say ("  OK  注册了 " + $id) } else { Say ("  ✘ 少了 " + $id); $ok = $false }
    }
} else { Say "  ✘ publish.xml 没生成"; $ok = $false }

$rt = Join-Path $app 'dsh-wps\runtime'
if (Test-Path $rt) {
    $files = Get-ChildItem $rt -Recurse -File
    $sz = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
    Say ("  OK  便携运行时: " + $files.Count + " 个文件, " + $sz + " MB  -> " + (($files | ForEach-Object { $_.Name }) -join ', '))
} else { Say "  ✘ 便携运行时没下载"; $ok = $false }

$vb = Join-Path $app 'dsh-wps\start-hidden.vbs'
Say ("  " + $(if (Test-Path $vb) { "OK" } else { "✘" }) + "  隐藏启动器已生成 (start-hidden.vbs)")

# ---------- 6. 服务停掉后，用【点我修复助手】手动拉起来 ----------
Say "`n[6/7] 停掉服务，再用【点我修复助手】手动拉起（`"本地服务没有运行`" 那条路）"

# 只按「端口占用者」定位服务进程 —— 用 CommandLine 模糊匹配会把本机跑着的
# 其它 dsh-wps 服务、甚至测试框架自己的进程一起杀掉（这个坑真踩过：
# 上一版把用户 43130 上的正式服务和后台任务进程一起干掉了）。
function Stop-ServiceOnPort($p) {
    $n = 0
    foreach ($conn in (Get-NetTCPConnection -LocalPort ([int]$p) -State Listen -ErrorAction SilentlyContinue)) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; $n++ }
    }
    return $n
}

Say ("  停掉端口 $port 上的服务进程: " + (Stop-ServiceOnPort $port) + " 个")
Start-Sleep -Seconds 2
try { Invoke-RestMethod ("http://127.0.0.1:$port/api/ping") -TimeoutSec 4 | Out-Null; Say "  ✘ 没停掉" }
catch { Say "  OK  服务已停" }

# 这个脚本会一直占着窗口跑服务，所以放到后台，验完再杀掉
$fixerProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$($fixer.FullName)`" < nul" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 7
try {
    $ping2 = Invoke-RestMethod ("http://127.0.0.1:$port/api/ping") -TimeoutSec 8
    Say ("  OK  【点我修复助手】把服务拉起来了: ok=" + $ping2.ok)
} catch { Say ("  ✘ 【点我修复助手】没能拉起服务: " + $_.Exception.Message); $ok = $false }
Say ("  收尾：停掉服务进程 " + (Stop-ServiceOnPort $port) + " 个")
Stop-Process -Id $fixerProc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ---------- 7. 卸载 ----------
Say "`n[7/7] 执行【点我卸载助手】，检查是否清干净"
$out2 = & cmd.exe /c "`"$($uninstaller.FullName)`" < nul" 2>&1
foreach ($line in $out2) { Say ("  | " + $line) }
Start-Sleep -Seconds 3

try {
    Invoke-RestMethod ("http://127.0.0.1:$port/api/ping") -TimeoutSec 5 | Out-Null
    Say "  ✘ 卸载后服务还在跑"; $ok = $false
} catch { Say "  OK  卸载后服务已停" }

$pubNow = Get-Content $pub -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if ($pubNow -and $pubNow -match 'DshWps') { Say "  ✘ publish.xml 里还留着注册项"; $ok = $false }
else { Say "  OK  publish.xml 里的注册项已移除" }

$runKey = (Get-ItemProperty -Path $runKeyPath -Name 'DshWpsService' -ErrorAction SilentlyContinue).DshWpsService
if ($runKey) { Say ("  ✘ 自启注册表还在: " + $runKey); $ok = $false } else { Say "  OK  自启注册表已清除" }

# ---------- 收尾：还原本机原有的开机自启项 ----------
if ($runKeyBackup) {
    Set-ItemProperty -Path $runKeyPath -Name 'DshWpsService' -Value $runKeyBackup -Force
    Say ("  已还原本机原有自启项: " + $runKeyBackup)
}

# ---------- 先出结论，再收拾现场 ----------
# 顺序不能反：删掉临时目录后，Say 写日志就会失败（目录都没了）。
Say "`n================ 结果 ================"
Say $(if ($ok) { "  全部通过 ✔" } else { "  有失败项 ✘" })

# ---------- 收尾：清掉临时目录 ----------
# 【点我修复助手】拉起服务后，那个 powershell 会停在「按任意键关闭」等着，
# 而它的工作目录就是解压出来的项目目录 —— 不先杀掉，目录删不掉。
if ($Keep) {
    Write-Host ('  -Keep 已指定，保留临时目录: ' + $root)
} else {
    $leftover = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($root) -and
            $_.Name -in @('powershell.exe', 'cmd.exe', 'node.exe', 'wscript.exe', 'conhost.exe')
        }
    foreach ($p in $leftover) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($leftover) { Write-Host ("  清掉 " + @($leftover).Count + " 个残留进程") }
    Start-Sleep -Seconds 2
    try {
        Remove-Item $root -Recurse -Force -ErrorAction Stop
        Write-Host '  临时目录已删除'
    } catch {
        Write-Host ('  临时目录删不掉（不影响结论），手动删即可: ' + $root)
    }
}

exit $(if ($ok) { 0 } else { 1 })
