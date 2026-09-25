# 运维

## 进程与文件

| 东西 | 在哪 | 说明 |
|---|---|---|
| daemon | `npm run daemon` → `tsx src/daemon.ts` | 单实例；pid 在 `data/daemon.pid` |
| 看门狗 | `scripts/daemon-watchdog.ps1` / `.sh` | 每 2 分钟一次；pid（循环方式启动时）在 `data/watchdog.pid`；bash 版的重启节流时间戳在 `data/watchdog.last-restart` |
| webhook / 预览服务 | `npm run webhook` → `src/gitlab/service.ts` | 可选；:8377；pid 在 `data/webhook.pid` |
| 控制台 | `npm run console` → `src/console/service.ts` | 可选；:8378；pid 在 `data/console.pid`；日志 `logs/console.log` |
| 运行态心跳 | `data/runtime.json` | daemon 每 10 秒写：闸门占用、在跑工单、待答卡片。控制台与人都可读 |
| 热重载信号 / 动作队列 | `data/env.reload`、`data/console.queue.jsonl` | 控制台写、daemon 10 秒内消费 |
| daemon 日志 | `logs/daemon.log` | 追加写；>1MB 启动时轮转，保留 14 天 |
| 看门狗日志 | `logs/watchdog.log` | 重启记录、备份结果、跳过原因 |
| Node 致命错误报告 | `logs/reports/` | `--report-on-fatalerror`；无声退出时唯一的取现场手段 |
| 工单状态 | `data/<ticket>.json` | 游标、回环计数、待答卡点、成本台账 |
| 事件流 | `data/<ticket>.events.jsonl` | append-only，事实源 |
| 续聊指针 | `data/last-run.<chat>.json`、`data/run-sessions.json` | 按群的最近一次 /run；结果卡 → 会话映射 |
| 话题绑定 | `data/threads.json` | 话题根消息 → 会话/工单 |
| 每日备份 | `backups/data-YYYYMMDD.zip`（Windows）/ `.tar.gz`（Unix） | 看门狗做，保留 14 天；Windows 版被占用的文件跳过并记名 |
| 停止信号 | `data/daemon.stop` | 见「部署新代码」 |

## 启动与停止

每个进程脚本有 PowerShell 与 bash 两版，参数形式对应：`-Stop` ↔ `--stop`。

```powershell
.\scripts\start-daemon.ps1         # 启动：冲突检查 → 装载 .env → 日志轮转 → 日志占用探测 → 启动 → 5 秒后核实
.\scripts\start-daemon.ps1 -Stop   # 停止：杀不动（提权进程）时改写停止信号文件
```

```bash
scripts/start-daemon.sh            # 同上（无日志占用探测：Unix 没有独占锁这回事）
scripts/start-daemon.sh --stop     # 杀整棵进程树；杀不动（别的用户 / systemd 拉起）时改写停止信号文件
```

启动脚本会做几件容易被忽略的事：检查是否已有编排器进程（一个飞书应用只能一条长连接）；以 UTF-8 读 `.env`（ANSI 读会吞掉非 ASCII 注释后的换行）；探测日志文件是否被别的进程独占（被 `tail -f` 攥着时 cmd 的重定向会秒退但不报错）；启动后 5 秒核实进程还活着。

bash 版的 `.env` 装载与 `doctor.ts` 同一口径（逐行按第一个 `=` 切分，不 `source`——JSON 值里的引号会被 shell 吃掉）。

## 看门狗

处理两类故障：**进程死了** → 拉起；**进程活着但飞书长连接僵死**（DNS 抖动后 SDK 重试不自愈，实测过）→ 无在跑会话时重启。安全约束：daemon 树下有 `bash` / `claude` 子进程（阶段会话在跑）时绝不重启；10 分钟内不重复重启。顺带每日备份 `data/`、修剪自身日志、守护 webhook 进程。

**注册为计划任务**（管理员终端，随开机自启）：

```powershell
schtasks /Create /TN "PipelineDaemonWatchdog" /SC MINUTE /MO 2 /F `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:\work\demo\pipeline-orchestrator\scripts\daemon-watchdog.ps1\""
```

或不注册、跑一个循环（不随开机自启）：

```powershell
.\scripts\start-watchdog.ps1
.\scripts\start-watchdog.ps1 -Stop
```

**Linux / macOS**：用 cron，两个系统都行：

```bash
crontab -e
# 加一行（路径换成你的）
*/2 * * * * /opt/pipeline-orchestrator/scripts/daemon-watchdog.sh
```

或循环方式试跑：`scripts/start-watchdog.sh` / `--stop`。想用 systemd timer 也可以，把 `ExecStart` 指到 `daemon-watchdog.sh`、`OnUnitActiveSec=2min` 即可；macOS launchd 用 `StartInterval` 120。看门狗自身不依赖任何调度器特性。

bash 版与 PowerShell 版行为一致，三处差异：备份是 `tar.gz` 而非 zip；重启节流用 `data/watchdog.last-restart` 里的 epoch 秒而不是解析日志时间（免去 GNU/BSD `date` 差异）；「有会话在跑」判据是 daemon 树下有 `claude` / `codex` 进程或 `bash` 子进程（启动器自身那层 bash 排除）。

> **提权陷阱**：以管理员账号注册的计划任务拉起的 daemon 是高完整性进程，普通 shell 对它**看不见命令行、杀不动、探活报权限错误**——很容易误判成"进程已死"。实测把任务 RunLevel 改成 Limited 对管理员账号也不起作用。不要试图 `taskkill`，统一用下面的停止信号。`doctor` 会把这种情况标为「运行中但为提权进程」。

## 部署新代码

```powershell
# 1. 拉代码、跑测试
git pull; npm run typecheck; npm test
# 2. 写停止信号
Set-Content data\daemon.stop (Get-Date -Format o)
```

```bash
git pull && npm run typecheck && npm test
date -Iseconds > data/daemon.stop        # 或 scripts/start-daemon.sh --stop，杀不动时它也写这个文件
```

daemon 每 10 秒看一眼信号文件：**没有阶段会话在执行时**自行退出，看门狗 2 分钟内以新代码拉起。有会话在跑就等它结束再退（日志会记「收到停止信号，但有 N 个阶段会话在执行」）；有卡片在等人的工单不算忙——卡点卡会原样重发、问题卡由「继续」重问，但为了不吞掉刚发出去的卡，会最多等 5 分钟。启动时清掉残留信号文件，防止起来就自杀。

只改了 `pipeline-plugin` 的 skill **不需要重启**：会话每次启动时现读。只改了目标仓库的 `PIPELINE.md` 也不需要重启。改了 `.env`：从控制台改的会热重载（见下）；手改的写一下 `data/env.reload` 也能热重载，或者重启。启动时冻结的键（飞书三键、并发数、默认项目、路径）只能重启。

## 控制台

内网网页（默认 :8378，口令 `CONSOLE_TOKEN`）：总览与体检、任务 / 需求 / 文档 / 日志只读，环境与项目配置可改并热重载，重启按钮，工单暂停 / 继续。

```powershell
.\scripts\start-console.ps1          # 启动（需 .env 里有 CONSOLE_TOKEN）；有 pid 文件后看门狗一并守护
.\scripts\start-console.ps1 -Stop
```

```bash
scripts/start-console.sh / --stop
```

它是独立进程，与 daemon 之间只有文件：读 `data/runtime.json` 心跳，改 `.env` 后写 `data/env.reload`，重启 = 写 `data/daemon.stop`（与手工部署同一条路，同样受「有会话在跑就等」和看门狗 10 分钟节流约束），继续工单 = 追加 `data/console.queue.jsonl`。凭据值永不下发到浏览器；`.env` 每次改动前整份备份进 `backups/`。

## 体检

```bash
npx tsx scripts/doctor.ts             # 全量（含一次约 $0.01 的真实推理探测）
npx tsx scripts/doctor.ts --no-infer  # 零成本
```

分四组：依赖（node / git / bash / claude / glab / 有项目选了 codex 时查 codex 登录态）、编排器自身（插件目录、settings 文件）、项目配置（每个项目的仓库路径、`.gitignore` 是否屏蔽 `docs/pipeline` 或 `CLAUDE.md`、有无 `PIPELINE.md`、CI 配置完整性、前缀冲突）、连通性（飞书 token、多维表格、GitLab、Jenkins、wiki）、daemon 存活。任何 ❌ 以退出码 1 结束，适合放进巡检。

## 日常观察

- `/dashboard`（群里）：常用链接 + 运行情况 + 工单一览 + 三个质量指标（评审一次通过率 / 修复轮 / 验收返工）。
- `/status <ticket>`：时间线。
- `logs/daemon.log` 里 `[daemon]` 前缀的行是编排器自己的日志；`[info]` 是飞书 SDK 的。
- 成本：`data/<ticket>.json` 的 `runs[].costUsd`；Codex 阶段要配了价目表才有数，否则记 0 并在结果里注明「未计价」。

## 知识库老化审计

daemon 每 30 天自动发一次老化报告到群（零成本，只读表 + 命中日志）。手动跑：`npx tsx scripts/kb-refresh-audit.ts`。确认过时的条目在知识表把状态改「已失效」；阶段会话核实到过时也会回报 `stale_hints`，闭环时发人审卡。

## 一次性 / 迁移脚本

`scripts/` 下带 `-setup`、`-migrate`、`-fix`、`-backfill` 后缀的是幂等的一次性脚本，头三行注释写用法。带 `-probe` 的是只读探针，用于核实"到底成没成"。全部脚本自己装载 `.env`，不回显任何密钥值。完整清单见 [commands.md](commands.md#运维脚本)。

## 平台说明

- bash 脚本只用 bash 3.2（macOS 自带版本）也有的特性：无 `mapfile`、无关联数组、无 GNU `date -d`；文件大小用 `wc -c`，进程树用 `ps -eo pid=,ppid=` 自己 BFS。
- 生产执行机是 Windows。PowerShell 5.1：`Invoke-WebRequest` 无 `-SkipHttpErrorCheck`；`Set-Content` 默认 ANSI，写 UTF-8 要显式 `-Encoding utf8`；无 BOM 的 UTF-8 脚本含中文注释会被按 ANSI 读并吞掉换行——脚本用纯 ASCII 注释或加 BOM。
- 起子进程**不经 shell**：`spawn(..., { shell: true })` 下 Node 不给参数加引号，带空格换行中文的提示词会被拆成一串参数（Codex 评审曾因此第一秒崩）。
- 孤儿进程检测用 `-EncodedCommand` 调 PowerShell，不经 cmd 转发（cmd 不认转义引号、把内层管道当自己的）。
