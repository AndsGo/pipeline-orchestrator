# daemon 看门狗：由计划任务每 2 分钟调一次。
# 处理两类故障：① 进程死了 → 拉起；② 进程活着但飞书长连接僵死（2026-08-16 实证：
# DNS 抖动后 SDK 重试不自愈，"活着但聋"）→ 无在跑会话时重启。
# 安全约束：daemon 树下有 bash/claude 子进程（阶段会话在跑）时绝不重启；10 分钟内不重复重启。
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\daemon.pid'
$log = Join-Path $root 'logs\daemon.log'
$wdLog = Join-Path $root 'logs\watchdog.log'

function WdLog([string]$msg) {
  New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
  Add-Content -Path $wdLog -Value "$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')) $msg" -Encoding utf8
}

function RestartDaemon([string]$reason) {
  # 节流：10 分钟内已重启过就不再动（DNS 长时间断时避免无意义的重启循环）
  if (Test-Path $wdLog) {
    # -cmatch 大小写敏感：skip 行里的小写 restart 不能刷新节流时间戳（曾因此永久跳过重启）
    $last = Get-Content $wdLog -Tail 50 -Encoding UTF8 | Where-Object { $_ -cmatch ' RESTART ' } | Select-Object -Last 1
    if ($last -and ($last -match '^(\S+) ') -and ((Get-Date) - [datetime]$matches[1]).TotalMinutes -lt 10) {
      WdLog "skip restart ($reason)：10 分钟内已重启过"
      return
    }
  }
  WdLog "RESTART ($reason)"
  & (Join-Path $PSScriptRoot 'start-daemon.ps1') -Stop | Out-Null
  Start-Sleep -Seconds 3
  & (Join-Path $PSScriptRoot 'start-daemon.ps1') | Out-Null
}

# ① 进程存活
$daemonPid = if (Test-Path $pidFile) { Get-Content $pidFile } else { $null }
$alive = $daemonPid -and (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)
if (-not $alive) {
  RestartDaemon 'dead'
  return
}

# ② 僵死检测：日志里最后一次 ws client ready 之后仍出现 ≥3 条连接错误 → 聋了
if (-not (Test-Path $log)) { return }
$tail = Get-Content $log -Tail 300 -Encoding UTF8
$lastReady = -1
for ($i = 0; $i -lt $tail.Count; $i++) { if ($tail[$i] -match 'ws client ready') { $lastReady = $i } }
$errAfter = 0
for ($j = $lastReady + 1; $j -lt $tail.Count; $j++) {
  if ($tail[$j] -match 'getaddrinfo|unable to connect') { $errAfter++ }
}
if ($errAfter -lt 3) { return }

# 安全闸：daemon 进程树下有 bash/claude（阶段会话在跑）→ 只记录不重启，宁可聋不杀活
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$queue = @([int]$daemonPid); $busy = $false
while ($queue.Count -gt 0 -and -not $busy) {
  $next = @()
  foreach ($p in $queue) {
    foreach ($k in ($all | Where-Object { $_.ParentProcessId -eq $p })) {
      if ($k.Name -in @('bash.exe', 'claude.exe')) { $busy = $true; break }
      $next += [int]$k.ProcessId
    }
  }
  $queue = $next
}
if ($busy) {
  WdLog "deaf（错误 $errAfter 条）但有在跑会话，跳过重启"
  return
}
RestartDaemon "deaf（ready 之后 $errAfter 条连接错误）"
