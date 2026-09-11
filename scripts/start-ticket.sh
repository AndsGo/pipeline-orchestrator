#!/usr/bin/env bash
# 启动一个工单（分离进程 + 飞书交互；Linux / macOS，Windows 用 start-ticket.ps1）。用法：
#   scripts/start-ticket.sh --repo /work/lake_spirit --ticket LS-003 --requirement "需求原文"
#   scripts/start-ticket.sh --repo /work/lake_spirit --ticket LS-003 --start review     # 断点续跑
#   可选：--lane fast|full
set -u
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
repo=""; ticket=""; requirement=""; start=""; lane=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --ticket) ticket="$2"; shift 2 ;;
    --requirement) requirement="$2"; shift 2 ;;
    --start) start="$2"; shift 2 ;;
    --lane) lane="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] && [ -n "$ticket" ] || { echo "用法：start-ticket.sh --repo <路径> --ticket <工单> [--requirement ...] [--start <阶段>] [--lane fast|full]" >&2; exit 2; }
case "$lane" in ''|fast|full) ;; *) echo "--lane 只能是 fast 或 full" >&2; exit 2 ;; esac

load_env || exit 1
mkdir -p "$root/logs"
log="$root/logs/$ticket.log"
set -- run orchestrate -- "$repo" "$ticket" --feishu
[ -n "$requirement" ] && set -- "$@" --requirement "$requirement"
[ -n "$start" ] && set -- "$@" --start "$start"
[ -n "$lane" ] && set -- "$@" --lane "$lane"
cd "$root" || exit 1
nohup npm "$@" > "$log" 2>&1 &
pid=$!
echo "工单 $ticket 已启动（pid $pid），日志：$log"
echo "后续交互全部在飞书群进行；挂起后续跑：scripts/start-ticket.sh --repo $repo --ticket $ticket"
