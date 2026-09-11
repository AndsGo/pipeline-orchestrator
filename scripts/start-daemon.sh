#!/usr/bin/env bash
# 启动常驻编排 daemon（Linux / macOS；Windows 用 start-daemon.ps1）。单实例，持有唯一飞书长连接。
#   scripts/start-daemon.sh            # 启动
#   scripts/start-daemon.sh --stop     # 停止（杀不动时改写停止信号 data/daemon.stop）
set -u
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
pid_file="$root/data/daemon.pid"
log="$root/logs/daemon.log"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$pid_file" ]; then
    old="$(cat "$pid_file")"
    kill_tree "$old"
    if pid_exists "$old"; then
      # 杀不动（别的用户 / systemd 拉起的）就走信号文件：daemon 每 10 秒检查一次，无会话在执行时自行退出，看门狗随后拉起
      mkdir -p "$root/data"; now_iso > "$root/data/daemon.stop"
      echo "daemon (pid $old) 本用户杀不动；已写入停止信号 data/daemon.stop。"
      echo "它会在空闲时自行退出（有阶段会话在跑则先等），看门狗 2 分钟内以最新代码拉起。观察：tail -f logs/daemon.log"
      exit 0
    fi
    rm -f "$pid_file"
    echo "daemon (pid $old) 已停止"
  else
    echo "daemon 未在运行（无 pid 文件）"
  fi
  exit 0
fi

# 冲突检查：一个飞书应用只能有一条有效长连接，多实例会互相抢卡片回调
busy="$(pgrep -f 'src/(daemon|cli)\.ts' 2>/dev/null || true)"
if [ -n "$busy" ]; then
  echo "检测到已有编排器进程在跑，先停掉再启动 daemon（否则会抢飞书回调）："
  for p in $busy; do echo "  pid $p: $(ps -o args= -p "$p" | cut -c1-120)"; done
  exit 1
fi

load_env || exit 1
mkdir -p "$root/logs" "$root/data" "$root/logs/reports"
rotate_log "$log" daemon

# 崩溃诊断：Node 原生致命错误时把报告落到 logs/reports/（Windows 上五次 0xC0000409 无声退出后加的，这里同样开着）
export NODE_OPTIONS="--report-on-fatalerror --report-directory=$root/logs/reports"
cd "$root" || exit 1
# 外层 bash 记录 node 退出码：有这一行 = node 自己死的；连这一行都没有 = 整棵树被外力杀掉
nohup bash -c 'npm run daemon >> "$1" 2>&1; code=$?; echo "[wrapper] $(date +%Y-%m-%dT%H:%M:%S) daemon exited code=$code" >> "$1"' _ "$log" >/dev/null 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"

# 启动核实：拿到 pid 就返回会报假成功，等 5 秒看它还在不在
sleep 5
if ! pid_exists "$pid" && ! pgrep -f 'src/daemon\.ts' >/dev/null 2>&1; then
  rm -f "$pid_file"
  echo "daemon 启动失败（进程已退出）。日志尾部："
  [ -f "$log" ] && tail -n 20 "$log" | sed 's/^/  /'
  wdlog "START-FAILED（进程秒退，详见 daemon.log 尾部）"
  exit 1
fi
echo "daemon 已启动（pid $pid），日志：$log"
echo "之后所有操作都在飞书群里：@bot /help 查看指令"
