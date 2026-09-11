#!/usr/bin/env bash
# 进程脚本共用函数（Linux / macOS）。被 start-daemon.sh / start-webhook.sh / start-watchdog.sh /
# daemon-watchdog.sh / start-ticket.sh source，不单独执行。只用 bash 3.2 也有的特性（macOS 自带版本）。
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

now_iso() { date +%Y-%m-%dT%H:%M:%S; }

# 装载 .env：与 scripts/doctor.ts 同一口径——跳过 # 开头的行，按第一个 = 切分，键值两端去空白。
# 不能 source：PIPELINE_PROJECTS 的 JSON 值带引号和花括号，shell 会把引号吃掉。
load_env() {
  local f="$root/.env" line key val
  [ -f "$f" ] || { echo "缺 .env（复制 .env.example 填值）" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*|' '*\#*) [ "${line#"${line%%[![:space:]]*}"}" = "" ] && continue ;; esac
    case "${line#"${line%%[![:space:]]*}"}" in \#*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$key" in [A-Za-z_]*) ;; *) continue ;; esac
    export "$key=$val"
  done < "$f"
}

# 进程是否存在（ps 看得到即存在；kill -0 遇到别的用户的进程会 EPERM，不能拿它判死活）
pid_exists() { [ -n "${1:-}" ] && ps -p "$1" >/dev/null 2>&1; }
# 本用户能否向它发信号
pid_signalable() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# 列出某进程的全部后代 pid（BFS，用 ps 的 pid/ppid 快照）
descendants() {
  local queue="$1" next p k snapshot
  snapshot="$(ps -eo pid=,ppid= 2>/dev/null)"
  while [ -n "$queue" ]; do
    next=""
    for p in $queue; do
      for k in $(printf '%s\n' "$snapshot" | awk -v pp="$p" '$2==pp{print $1}'); do
        printf '%s\n' "$k"; next="$next $k"
      done
    done
    queue="$next"
  done
}

# 杀整棵进程树（等价 taskkill /T /F）：先 TERM 全体，1 秒后对还活着的 KILL
kill_tree() {
  local rootpid="$1" all p
  all="$(descendants "$rootpid") $rootpid"
  for p in $all; do kill -TERM "$p" 2>/dev/null; done
  sleep 1
  for p in $all; do pid_signalable "$p" && kill -KILL "$p" 2>/dev/null; done
  return 0
}

# 日志轮转：超过 1MB 才挪走，保留 14 天（与 data/ 备份同一保留期）。追加写，不覆盖——
# 覆盖会把上一份崩溃现场清掉（2026-08-21 那次就这么丢的）
rotate_log() {
  local file="$1" prefix="$2" size
  if [ -f "$file" ]; then
    size="$(wc -c < "$file" | tr -d ' ')"
    if [ "$size" -gt 1048576 ]; then mv "$file" "$root/logs/$prefix-$(date +%Y%m%d-%H%M%S).log" 2>/dev/null || true; fi
  fi
  find "$root/logs" -name "$prefix-*.log" -mtime +14 -delete 2>/dev/null || true
}

wdlog() {
  mkdir -p "$root/logs"
  printf '%s %s\n' "$(now_iso)" "$*" >> "$root/logs/watchdog.log"
}
