#!/usr/bin/env bash
# daemon 看门狗（Linux / macOS；Windows 用 daemon-watchdog.ps1）。由 cron 每 2 分钟调一次，或由 start-watchdog.sh 循环调。
#   crontab -e 加一行：  */2 * * * * /path/to/pipeline-orchestrator/scripts/daemon-watchdog.sh
# 处理两类故障：① 进程死了 → 拉起；② 进程活着但飞书长连接僵死（DNS 抖动后 SDK 重试不自愈，"活着但聋"）→ 无在跑会话时重启。
# 安全约束：daemon 树下有阶段会话（bash / claude / codex）在跑时绝不重启；10 分钟内不重复重启。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/_lib.sh"
pid_file="$root/data/daemon.pid"
log="$root/logs/daemon.log"
wd_log="$root/logs/watchdog.log"
last_restart="$root/data/watchdog.last-restart"   # 上次 RESTART 的 epoch 秒（ps1 版从日志解析时间；这里用状态文件，免去 GNU/BSD date 差异）

restart_daemon() {
  local reason="$1" now last first
  now="$(date +%s)"
  if [ -f "$last_restart" ]; then
    last="$(cat "$last_restart" 2>/dev/null || echo 0)"
    if [ $((now - last)) -lt 600 ]; then wdlog "skip restart ($reason)：10 分钟内已重启过"; return; fi
  fi
  wdlog "RESTART ($reason)"
  mkdir -p "$root/data"; printf '%s\n' "$now" > "$last_restart"
  "$here/start-daemon.sh" --stop >/dev/null 2>&1
  sleep 3
  # 启动脚本的第一行结论留进时间线——RESTART 之后 daemon.log 一个字没写时，至少知道启动脚本在哪一步返回
  first="$("$here/start-daemon.sh" 2>&1 | sed -n '1p')"
  wdlog "start-daemon → $first"
}

# pid 文件里的进程是不是我们的启动器：机器重启后旧 pid 可能被别的进程占用，只看存活会把陌生进程当活 daemon
is_our_daemon() {
  local p="$1" args
  [ -n "$p" ] || return 1
  pid_exists "$p" || return 1
  args="$(ps -o args= -p "$p" 2>/dev/null)"
  case "$args" in *"npm run daemon"*) return 0 ;; esac
  wdlog "pid $p 是「$(printf '%s' "$args" | cut -c1-60)」不是 daemon 启动器（pid 被复用），视为已死"
  return 1
}

# ⓪ 家务：watchdog 自身日志防膨胀（>4000 行截到最后 1000）；data/ 每日备份，保留 14 天
if [ -f "$wd_log" ] && [ "$(wc -l < "$wd_log" | tr -d ' ')" -gt 4000 ]; then
  tail -n 1000 "$wd_log" > "$wd_log.tmp" && mv "$wd_log.tmp" "$wd_log"
fi
bak_dir="$root/backups"
bak="$bak_dir/data-$(date +%Y%m%d).tar.gz"
if [ ! -f "$bak" ] && [ -d "$root/data" ]; then
  mkdir -p "$bak_dir"
  if tar -czf "$bak" -C "$root" data 2>/dev/null; then
    find "$bak_dir" -name 'data-*.tar.gz' -mtime +14 -delete 2>/dev/null || true
    wdlog "data/ 已备份 → $(basename "$bak")"
  else
    rm -f "$bak"; wdlog "备份失败：tar 返回非零"
  fi
fi

# ①b webhook 守护（仅当用 start-webhook.sh 启动过、存在 pid 文件时）
wh_pid_file="$root/data/webhook.pid"
if [ -f "$wh_pid_file" ] && ! pid_exists "$(cat "$wh_pid_file")"; then
  wdlog 'RESTART-WEBHOOK (dead)'
  "$here/start-webhook.sh" >/dev/null 2>&1
fi

# ① 进程存活
daemon_pid="$([ -f "$pid_file" ] && cat "$pid_file" || true)"
if ! is_our_daemon "$daemon_pid"; then
  restart_daemon dead
  exit 0
fi

# ② 僵死检测：日志里最后一次 ws client ready 之后仍出现 ≥3 条连接错误 → 聋了
[ -f "$log" ] || exit 0
err_after="$(tail -n 300 "$log" | awk '/ws client ready/{n=0; next} /getaddrinfo|unable to connect/{n++} END{print n+0}')"
[ "$err_after" -ge 3 ] || exit 0

# 安全闸：daemon 进程树下有阶段会话在跑 → 只记录不重启，宁可聋不杀活。
# 启动器本身就是 bash（外层记录退出码的那层），要排除；npm 起的 sh 不算会话
busy=0
for k in $(descendants "$daemon_pid"); do
  comm="$(ps -o comm= -p "$k" 2>/dev/null | sed 's#.*/##')"
  args="$(ps -o args= -p "$k" 2>/dev/null)"
  case "$args" in *"npm run daemon"*) continue ;; esac
  case "$comm" in claude|codex) busy=1; break ;; esac
  case "$args" in *claude*|*codex*) busy=1; break ;; esac
  [ "$comm" = "bash" ] && { busy=1; break; }
done
if [ "$busy" = 1 ]; then
  wdlog "deaf（错误 $err_after 条）但有在跑会话，跳过重启"
  exit 0
fi
restart_daemon "deaf（ready 之后 $err_after 条连接错误）"
