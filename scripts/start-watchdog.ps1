# 启动常驻看门狗循环（计划任务注册需要管理员权限时的替代方案）
#   .\scripts\start-watchdog.ps1          # 启动（每 2 分钟检查一次 daemon）
#   .\scripts\start-watchdog.ps1 -Stop    # 停止
# 注意：本方式不随开机自启。要开机自启，在管理员终端注册计划任务：
#   schtasks /Create /TN "PipelineDaemonWatchdog" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:\work\demo\pipeline-orchestrator\scripts\daemon-watchdog.ps1\"" /SC MINUTE /MO 2 /F
param([switch]$Stop)

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\watchdog.pid'

if ($Stop) {
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    cmd /c "taskkill /PID $old /T /F 2>nul" | Out-Null
    Remove-Item $pidFile -Force
    Write-Host "watchdog (pid $old) 已停止"
  } else { Write-Host 'watchdog 未在运行（无 pid 文件）' }
  return
}

if (Test-Path $pidFile) {
  $old = Get-Content $pidFile
  if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
    Write-Host "watchdog 已在运行（pid $old），如需重启先 -Stop"
    return
  }
}

$wd = Join-Path $PSScriptRoot 'daemon-watchdog.ps1'
$p = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"while (`$true) { & '$wd'; Start-Sleep -Seconds 120 }`"" `
  -WindowStyle Hidden -PassThru
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
Set-Content -Path $pidFile -Value $p.Id -Encoding utf8
Write-Host "watchdog 已启动（pid $($p.Id)），每 2 分钟检查一次；动作记录在 logs\watchdog.log"
