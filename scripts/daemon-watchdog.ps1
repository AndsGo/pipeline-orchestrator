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
  # 把启动脚本的第一行结论留进时间线：2026-09-07 重启机器后 14:50 那次 RESTART 之后 daemon.log 一个字没写、
  # watchdog.log 也没有 START-FAILED，11 分钟后第二次才起来——启动脚本在哪一步返回的完全查不到
  $out = (& (Join-Path $PSScriptRoot 'start-daemon.ps1') *>&1 | Out-String).Trim()
  $first = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
  WdLog "start-daemon → $first"
}

# pid 文件里的进程是不是我们那个 daemon 启动器：机器重启后旧 pid 可能被别的进程占用，
# 光看 Get-Process 会把陌生进程当活 daemon（2026-09-07 重启后 14:41～14:49 五轮没拉起）。
# 判据：进程名是 cmd（start-daemon 用 cmd /c npm run daemon 起的），且启动时间不晚于 pid 文件写入时间 + 10 秒
function IsOurDaemon([string]$daemonPid) {
  if (-not $daemonPid) { return $false }
  $p = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  try {
    if ($p.ProcessName -ne 'cmd') { WdLog "pid $daemonPid 是 $($p.ProcessName) 不是 daemon 启动器，视为已死"; return $false }
    if ($p.StartTime -gt (Get-Item $pidFile).LastWriteTime.AddSeconds(10)) { WdLog "pid $daemonPid 的进程晚于 pid 文件启动（pid 被复用），视为已死"; return $false }
  } catch { return $false }
  return $true
}

# ⓪ 家务：watchdog 自身日志防膨胀（>4000 行截到最后 1000）；data/ 每日备份，保留 14 天
if ((Test-Path $wdLog) -and ((Get-Content $wdLog | Measure-Object -Line).Lines -gt 4000)) {
  $keep = Get-Content $wdLog -Tail 1000 -Encoding UTF8
  Set-Content -Path $wdLog -Value $keep -Encoding utf8
}
$bakDir = Join-Path $root 'backups'
$bak = Join-Path $bakDir "data-$((Get-Date).ToString('yyyyMMdd')).zip"
if (-not (Test-Path $bak)) {
  try {
    New-Item -ItemType Directory -Force $bakDir | Out-Null
    # 逐文件复制到暂存目录再压缩：一个被占用的文件（实测 2026-08-30 起 tail -F 攥着 LS-003.events.jsonl）
    # 曾让 Compress-Archive 整体失败，连续三天零备份。现在占用的跳过并记名，其余照常入包
    $stage = Join-Path $bakDir '_stage'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -Confirm:$false }
    New-Item -ItemType Directory -Force $stage | Out-Null
    $skipped = @()
    foreach ($f in Get-ChildItem (Join-Path $root 'data') -File) {
      try { Copy-Item $f.FullName (Join-Path $stage $f.Name) -ErrorAction Stop } catch { $skipped += $f.Name }
    }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $bak -ErrorAction Stop
    Remove-Item $stage -Recurse -Force -Confirm:$false
    Get-ChildItem $bakDir -Filter 'data-*.zip' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
      Remove-Item -Force -Confirm:$false
    WdLog "data/ 已备份 → $(Split-Path $bak -Leaf)$(if ($skipped) { "（跳过被占用：$($skipped -join '、')）" })"
  } catch { WdLog "备份失败：$($_.Exception.Message)" }
}

# ①b webhook 守护（仅当用 start-webhook.ps1 启动过、存在 pid 文件时）：进程死了就拉起
$whPidFile = Join-Path $root 'data\webhook.pid'
if (Test-Path $whPidFile) {
  $whPid = Get-Content $whPidFile
  if (-not (Get-Process -Id $whPid -ErrorAction SilentlyContinue)) {
    WdLog 'RESTART-WEBHOOK (dead)'
    & (Join-Path $PSScriptRoot 'start-webhook.ps1') | Out-Null
  }
}

# ① 进程存活
$daemonPid = if (Test-Path $pidFile) { Get-Content $pidFile } else { $null }
$alive = IsOurDaemon $daemonPid
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
