# 启动一个工单（分离进程 + 飞书交互）。用法：
#   .\scripts\start-ticket.ps1 -Repo D:/work/lake_spirit -Ticket LS-003 -Requirement "需求原文"
#   .\scripts\start-ticket.ps1 -Repo D:/work/lake_spirit -Ticket LS-003 -Start review   # 断点续跑
param(
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][string]$Ticket,
  [string]$Requirement,
  [string]$Start,
  [ValidateSet('fast','full')][string]$Lane
)
$root = Split-Path $PSScriptRoot -Parent
# 加载 .env
# 必须显式 UTF8：按 ANSI 读取时 .env 里的非 ASCII 注释会吞掉换行、粘连下一行配置
Get-Content (Join-Path $root '.env') -Encoding UTF8 | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}
$args = "run orchestrate -- $Repo $Ticket --feishu"
if ($Requirement) { $args += " --requirement `"$Requirement`"" }
if ($Start) { $args += " --start $Start" }
if ($Lane) { $args += " --lane $Lane" }
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
$log = Join-Path $root "logs\$Ticket.log"
$p = Start-Process -FilePath 'cmd' -ArgumentList "/c npm $args > `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Write-Host "工单 $Ticket 已启动（pid $($p.Id)），日志：$log"
Write-Host "后续交互全部在飞书「流水线」群进行；挂起后续跑：.\scripts\start-ticket.ps1 -Repo $Repo -Ticket $Ticket"
