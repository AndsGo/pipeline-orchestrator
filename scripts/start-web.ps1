# 启动 web 服务：GitLab MR 评审 + 结果预览 + 控制台，一个进程一个端口（GITLAB_WEBHOOK_PORT，默认 8377）
#   .\scripts\start-web.ps1            # 启动
#   .\scripts\start-web.ps1 -Stop      # 停止（杀不动提权进程时改写停止信号 data\web.stop）
# 用本脚本启动后（存在 data\web.pid），daemon 看门狗会一并守护它。
# 直接 node --import tsx 起，不经 npm / tsx 命令行：少两层包装进程，每个省约 50MB（2026-09-25）
param([switch]$Stop)

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\web.pid'
$log = Join-Path $root 'logs\web.log'

if ($Stop) {
  if (Test-Path $pidFile) {
    $old = (Get-Content $pidFile -Raw).Trim()
    cmd /c "taskkill /PID $old /T /F 2>nul" | Out-Null
    Start-Sleep -Milliseconds 800
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
      Set-Content -Path (Join-Path $root 'data\web.stop') -Value (Get-Date -Format o) -Encoding utf8
      Write-Host "web (pid $old) 是提权进程，本 shell 杀不动；已写入停止信号 data\web.stop，它 5 秒内自退、看门狗拉起。" -ForegroundColor Yellow
      return
    }
    Remove-Item $pidFile -Force
    Write-Host "web (pid $old) 已停止"
  } else { Write-Host 'web 未在运行（无 pid 文件）' }
  return
}

$busy = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[/\\]web[/\\]main\.ts' }
if ($busy) {
  Write-Host '检测到已有 web 进程在跑，先停掉再启动：' -ForegroundColor Yellow
  $busy | ForEach-Object { Write-Host "  pid $($_.ProcessId)" }
  return
}

# 与 start-daemon 相同的 .env 加载（必须显式 UTF8）
Get-Content (Join-Path $root '.env') -Encoding UTF8 | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
  try { Move-Item $log (Join-Path $root "logs\web-$((Get-Date).ToString('yyyyMMdd-HHmmss')).log") -ErrorAction Stop } catch { }
}
$p = Start-Process -FilePath 'cmd' -ArgumentList "/c node --import tsx src/web/main.ts >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $p.Id -Encoding ascii
Write-Host "web 已启动（pid $($p.Id)），日志：$log"
