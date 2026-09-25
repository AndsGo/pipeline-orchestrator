# 启动控制台（可选常驻进程，默认端口 8378；需 .env 里的 CONSOLE_TOKEN）
#   .\scripts\start-console.ps1            # 启动
#   .\scripts\start-console.ps1 -Stop      # 停止
# 用本脚本启动后（存在 data\console.pid），daemon 看门狗会一并守护它。
param([switch]$Stop)

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\console.pid'
$log = Join-Path $root 'logs\console.log'

if ($Stop) {
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    cmd /c "taskkill /PID $old /T /F 2>nul" | Out-Null
    Remove-Item $pidFile -Force
    Write-Host "console (pid $old) 已停止"
  } else { Write-Host 'console 未在运行（无 pid 文件）' }
  return
}

$busy = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'console[/\\]service' }
if ($busy) {
  Write-Host '检测到已有 console 进程在跑，先停掉再启动：' -ForegroundColor Yellow
  $busy | ForEach-Object { Write-Host "  pid $($_.ProcessId)" }
  return
}

# 与 start-daemon 相同的 .env 加载（npm 脚本不会自己读 .env）
Get-Content (Join-Path $root '.env') -Encoding UTF8 | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}
if (-not $env:CONSOLE_TOKEN) { Write-Host '缺 CONSOLE_TOKEN（.env），控制台不启动' -ForegroundColor Red; return }
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
$p = Start-Process -FilePath 'cmd' -ArgumentList "/c npm run console >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $p.Id -Encoding utf8
Write-Host "console 已启动（pid $($p.Id)），日志：$log"
