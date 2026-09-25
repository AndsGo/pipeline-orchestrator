# 注册 / 更新看门狗计划任务（需要管理员终端）
#   .\scripts\register-watchdog.ps1          # 每 2 分钟一次，只在有人登录时运行
#   .\scripts\register-watchdog.ps1 -S4U     # 不管有没有人登录都运行（机器重启后无人登录也能拉起 daemon）
#
# 动作用 conhost.exe --headless 包一层：计划任务直接跑 powershell.exe 会在桌面弹一个黑框，
# 平时一闪而过，重启 daemon / web 时脚本要跑十来秒就很显眼（2026-09-26 用户反馈）。
# -S4U 的取舍：任务在后台会话里跑，本来就没有窗口；以同一账号运行，~/.claude 登录态、git 配置照常可用，
# 但拿不到访问网络共享的凭据（本流水线只用本地盘和出站 HTTPS，不受影响）。
param([switch]$S4U)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host '需要管理员终端：右键 PowerShell →「以管理员身份运行」后再执行本脚本。' -ForegroundColor Red; return }

$script = Join-Path $PSScriptRoot 'daemon-watchdog.ps1'
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = if ($S4U) { New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited } else { New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited }

if (Get-ScheduledTask -TaskName 'PipelineDaemonWatchdog' -ErrorAction SilentlyContinue) {
  # 已存在：只换动作（和 -S4U 时的登录方式），触发器原样保留——别在更新时把「每 2 分钟」弄丢
  if ($S4U) { Set-ScheduledTask -TaskName 'PipelineDaemonWatchdog' -Action $action -Principal $principal | Out-Null }
  else { Set-ScheduledTask -TaskName 'PipelineDaemonWatchdog' -Action $action | Out-Null }
} else {
  # 新注册：与原 schtasks 写法同一节奏（每 2 分钟，无限重复）
  schtasks /Create /TN 'PipelineDaemonWatchdog' /SC MINUTE /MO 2 /F /TR "powershell.exe" | Out-Null
  Set-ScheduledTask -TaskName 'PipelineDaemonWatchdog' -Action $action -Principal $principal | Out-Null
}
$t = Get-ScheduledTask PipelineDaemonWatchdog
Write-Host "已注册 PipelineDaemonWatchdog：$($t.Principal.LogonType)，每 2 分钟，动作 $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
