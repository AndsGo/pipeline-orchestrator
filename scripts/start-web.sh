#!/usr/bin/env bash
# 启动 web 服务（Linux / macOS）：GitLab MR 评审 + 结果预览 + 控制台，一个进程一个端口（GITLAB_WEBHOOK_PORT，默认 8377）
#   scripts/start-web.sh           # 启动
#   scripts/start-web.sh --stop    # 停止（杀不动时改写停止信号 data/web.stop）
# 用本脚本启动后（存在 data/web.pid），daemon 看门狗会一并守护它。
set -u
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
pid_file="$root/data/web.pid"
log="$root/logs/web.log"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$pid_file" ]; then
    old="$(cat "$pid_file")"
    if pid_signalable "$old"; then kill_tree "$old"; rm -f "$pid_file"; echo "web (pid $old) 已停止"
    else date -Iseconds > "$root/data/web.stop"; echo "web (pid $old) 本用户杀不动；已写停止信号 data/web.stop，它 5 秒内自退、看门狗拉起"; fi
  else echo "web 未在运行（无 pid 文件）"; fi
  exit 0
fi

busy="$(pgrep -f 'src/web/main.ts' 2>/dev/null || true)"
if [ -n "$busy" ]; then
  echo "检测到已有 web 进程在跑，先停掉再启动："; for p in $busy; do echo "  pid $p"; done; exit 1
fi

load_env || exit 1
mkdir -p "$root/logs" "$root/data"
rotate_log "$log" web
cd "$root" || exit 1
nohup bash -c 'node --import tsx src/web/main.ts >> "$1" 2>&1' _ "$log" >/dev/null 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
echo "web 已启动（pid $pid），日志：$log"
