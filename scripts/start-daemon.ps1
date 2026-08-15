# 启动常驻编排 daemon（单实例，持有唯一飞书长连接，支持多工单并行与群内指令）
#   .\scripts\start-daemon.ps1            # 启动
#   .\scripts\start-daemon.ps1 -Stop      # 停止
param([switch]$Stop)

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\daemon.pid'
$log = Join-Path $root 'logs\daemon.log'

if ($Stop) {
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    cmd /c "taskkill /PID $old /T /F 2>nul" | Out-Null
    Remove-Item $pidFile -Force
    Write-Host "daemon (pid $old) 已停止"
  } else { Write-Host 'daemon 未在运行（无 pid 文件）' }
  return
}

# 冲突检查：一个飞书应用只能有一条有效长连接，多实例会互相抢卡片回调
$busy = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[/\\](daemon|cli)\.ts' }
if ($busy) {
  Write-Host '检测到已有编排器进程在跑，先停掉再启动 daemon（否则会抢飞书回调）：' -ForegroundColor Yellow
  $busy | ForEach-Object { Write-Host "  pid $($_.ProcessId): $($_.CommandLine.Substring(0,[Math]::Min(120,$_.CommandLine.Length)))" }
  return
}

# 必须显式 UTF8：按 ANSI 读取时 .env 里的非 ASCII 注释会吞掉换行、粘连下一行配置
Get-Content (Join-Path $root '.env') -Encoding UTF8 | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
$p = Start-Process -FilePath 'cmd' -ArgumentList "/c npm run daemon > `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $p.Id -Encoding utf8
Write-Host "daemon 已启动（pid $($p.Id)），日志：$log"
Write-Host '之后所有操作都在飞书群里：@bot /help 查看指令'
