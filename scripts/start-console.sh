#!/usr/bin/env bash
# 启动控制台（Linux / macOS；可选常驻进程，默认端口 8378；需 .env 里的 CONSOLE_TOKEN）
#   scripts/start-console.sh           # 启动
#   scripts/start-console.sh --stop    # 停止
# 用本脚本启动后（存在 data/console.pid），daemon 看门狗会一并守护它。
set -u
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
pid_file="$root/data/console.pid"
log="$root/logs/console.log"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$pid_file" ]; then
    old="$(cat "$pid_file")"; kill_tree "$old"; rm -f "$pid_file"; echo "console (pid $old) 已停止"
  else echo "console 未在运行（无 pid 文件）"; fi
  exit 0
fi

busy="$(pgrep -f 'console/service' 2>/dev/null || true)"
if [ -n "$busy" ]; then
  echo "检测到已有 console 进程在跑，先停掉再启动："; for p in $busy; do echo "  pid $p"; done; exit 1
fi

load_env || exit 1
[ -n "${CONSOLE_TOKEN:-}" ] || { echo "缺 CONSOLE_TOKEN（.env），控制台不启动" >&2; exit 1; }
mkdir -p "$root/logs" "$root/data"
cd "$root" || exit 1
nohup bash -c 'npm run console >> "$1" 2>&1' _ "$log" >/dev/null 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
echo "console 已启动（pid $pid），日志：$log"
