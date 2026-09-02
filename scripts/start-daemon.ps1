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
    Start-Sleep -Milliseconds 800
    # 核实而不是假报：提权（看门狗计划任务）拉起的 daemon 在非提权 shell 里 taskkill 会静默失败，
    # 此前照样打印「已停止」并删 pid 文件——随后的启动被日志锁拦下，人却以为进程已死（2026-09-02 实测）
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
      # 杀不动就走信号文件：daemon 每 10 秒检查一次，空闲（无在跑工单、无待答卡片）时自行退出，看门狗随后拉起
      Set-Content -Path (Join-Path $root 'data\daemon.stop') -Value (Get-Date -Format o) -Encoding utf8
      Write-Host "daemon (pid $old) 是提权进程，本 shell 杀不动；已写入停止信号 data\daemon.stop。" -ForegroundColor Yellow
      Write-Host '它会在空闲时自行退出（有工单在跑或等卡片则先等），看门狗 2 分钟内以最新代码拉起。' -ForegroundColor Yellow
      Write-Host '观察：Get-Content logs\daemon.log -Tail 3 -Wait' -ForegroundColor Yellow
      return
    }
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

# 日志轮转：超过 1MB 才挪走（实测量级 ~1KB/半小时，正常几周都到不了），保留 14 天——
# 与 data/ 备份同一保留期。以前用 > 覆盖：每次重启把上一份清空，daemon 崩溃现场跟着没了
# （2026-08-21 13:59 那次崩溃就这么丢的，事后完全查不到原因），改成 >> 追加。
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
  $rotated = Join-Path $root "logs\daemon-$((Get-Date).ToString('yyyyMMdd-HHmmss')).log"
  try { Move-Item $log $rotated -ErrorAction Stop } catch { }
}
Get-ChildItem (Join-Path $root 'logs') -Filter 'daemon-*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -Confirm:$false

# 日志占用探测：cmd 的 >> 重定向要以写方式打开日志，被别的进程独占时 cmd 秒退、什么都不写。
# 2026-08-21 实测代价：会话里一个 tail -f 占着日志，连续 4 次启动全在这一步死掉，
# 而脚本照样打印「已启动」——半小时后才发现跑着的是提权拉起的孤儿 daemon。
try {
  [IO.File]::Open($log, 'Append', 'Write', 'Read').Dispose()
} catch {
  Write-Host "日志 $log 被其他进程占用，未启动。" -ForegroundColor Red
  Write-Host '通常意味着还有 daemon 在跑（含提权拉起的孤儿）或有 tail -f 盯着它；' -ForegroundColor Yellow
  Write-Host '先停掉占用方（提权拉起的需要同等权限），再启动。' -ForegroundColor Yellow
  return
}

$p = Start-Process -FilePath 'cmd' -ArgumentList "/c npm run daemon >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $p.Id -Encoding utf8

# 启动核实：Start-Process 拿到 pid 就返回，子进程秒死也一样返回——不核实就会报假成功
Start-Sleep -Seconds 5
$live = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[/\\]daemon\.ts' }
if (-not $live -and -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'daemon 启动失败（进程已退出）。日志尾部：' -ForegroundColor Red
  if (Test-Path $log) { Get-Content $log -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" } }
  # 无人值守时（看门狗调起）标准输出没人看，留一行到运维时间线里
  Add-Content -Path (Join-Path $root 'logs\watchdog.log') `
    -Value "$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')) START-FAILED（进程秒退，详见 daemon.log 尾部）" -Encoding utf8
  return
}
Write-Host "daemon 已启动（pid $($p.Id)），日志：$log"
Write-Host '之后所有操作都在飞书群里：@bot /help 查看指令'
