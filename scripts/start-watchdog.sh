#!/usr/bin/env bash
# 以循环方式跑看门狗（Linux / macOS；不随开机自启，适合先试跑）
#   scripts/start-watchdog.sh          # 启动（每 2 分钟检查一次 daemon）
#   scripts/start-watchdog.sh --stop   # 停止
# 生产上请改用系统调度，随开机自启：
#   cron（两个系统都行）：crontab -e 加  */2 * * * * /path/to/pipeline-orchestrator/scripts/daemon-watchdog.sh
#   systemd timer / launchd 示例见 docs/operations.md
set -u
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/_lib.sh"
pid_file="$root/data/watchdog.pid"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$pid_file" ]; then
    old="$(cat "$pid_file")"; kill_tree "$old"; rm -f "$pid_file"; echo "watchdog (pid $old) 已停止"
  else echo "watchdog 未在运行（无 pid 文件）"; fi
  exit 0
fi

if [ -f "$pid_file" ] && pid_exists "$(cat "$pid_file")"; then
  echo "watchdog 已在运行（pid $(cat "$pid_file")），如需重启先 --stop"; exit 0
fi

mkdir -p "$root/data" "$root/logs"
nohup bash -c 'while true; do "$1"; sleep 120; done' _ "$here/daemon-watchdog.sh" >/dev/null 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
echo "watchdog 已启动（pid $pid），每 2 分钟检查一次；动作记录在 logs/watchdog.log"
