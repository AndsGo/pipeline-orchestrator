# 管理页面（控制台）设计讨论稿

状态：讨论中（2026-09-25）。目标：一个网页，管环境配置、项目配置，能热更新 / 热重启，能看任务、需求、文档。

## 1. 现状事实（读代码得出）

**进程与端口**
- daemon 没有任何 HTTP 端口，对外只有飞书长连接；对内只有文件信号：`data/daemon.stop`（空闲自退）、`data/<ticket>.pause`（阶段边界暂停）。
- 唯一的 HTTP 进程是 webhook 服务（`src/gitlab/service.ts`，`node:http`，:8377，独立进程，看门狗守护），已兼职 `/preview/<ticket>/` 静态路由，内网可达（`PREVIEW_BASE_URL`）。
- 重启 = 写停止信号 → daemon 在无阶段会话执行时退出（等卡片最多 5 分钟）→ 看门狗 2 分钟内拉起。看门狗 10 分钟内不重复 RESTART；只在有人登录时运行（Interactive）；daemon 是提权进程，普通 shell 杀不动。

**配置在哪、怎么读**
- `.env` 约 40 个键，一半是凭据。启动脚本把它装进进程环境。
- 大部分模块每次调用时读 `env.X`（函数带 `env = process.env` 参数）：Bitable、Wiki、Jenkins、GitLab、模型开关（`PIPELINE_HINTS_OFF` / `PIPELINE_IMPLEMENT_MODEL` / `PIPELINE_RUN_*` / `PIPELINE_CLASSIFY_MODEL` / `PIPELINE_DOUBLE_REVIEW`）——这些改了 `process.env` 即生效。
- 启动时冻结的：飞书凭据与主群（长连接建立即定）、`PIPELINE_MAX_CONCURRENCY`（Semaphore 构造一次）、`PIPELINE_DATA_DIR` / `PIPELINE_PLUGIN_DIR`（路径）、`GITLAB_WEBHOOK_PORT`。
- 项目表 `PIPELINE_PROJECTS` 已有热更新先例：`/bind`、`/addproject` 走 `commitProjectsEnv`——整份 `.env` 备份进 `backups/`（已 gitignore）→ 精确改一行 → 原地替换 `ctx.projects`。
- 各阶段的模型 / 轮数 / 预算在 `src/config.ts` 的 `STAGES` 常量里，不在 `.env`；每个数字旁边都是实测校准的理由注释。

**数据在哪（页面的读源）**
| 想看什么 | 事实源 | 已有的读模型 |
|---|---|---|
| 任务（工单） | `data/<ticket>.json` + `data/<ticket>.events.jsonl` | `loadTicket`、`readEvents`、`timeline`、`totalCost`、`buildDashboard`（`/dashboard` 用的装配函数）|
| 需求 | `data/requirements/REQ-*.json`（首条需求才建目录） | `listReqs`、`renderPool` |
| 单次执行 / 话题 | `data/adhoc/*.md`、`data/threads.json`、`data/last-run.*.json` | `readLastRunFor`、`getThread` |
| 文档 | 各项目仓库 `docs/pipeline/<ticket>/`：00-intake、10-prd、20-plan、25-impl-report、30-review-rN、40-acceptance、90-retro、95-delivery、96-knowledge.json、prototype/；项目级 PROJECT-BRIEF.md、PIPELINE.md、system-map/ | `ticketDir`、`section`、`systemMapIndex` |
| 运行态（只在 daemon 内存里） | 闸门占用、在跑工单、待答卡片、adhoc 台账 | `RuntimeInfo`（`/dashboard` 现场拼的） |
| 健康 | 无落盘 | `scripts/doctor.ts`（只读、不输出凭据值） |

## 2. 关键决策（每条带推荐）

### 决策 1：页面跑在哪个进程
- A. 塞进 daemon（daemon 起一个 HTTP 端口）。运行态直接可读；但 daemon 一重启页面就断，「重启」按钮按下去自己先死，看不到过程；UI 的 bug 会拖死飞书长连接。
- B. **独立进程 `npm run console`（推荐）**，与 webhook 同构：`node:http`，共享 `data/` 和 `.env`，看门狗守护。写操作全走已有的文件协议（停止信号、暂停文件、`.env` 改写）。
- 代价：运行态要 daemon 主动落盘。加一个心跳：daemon 每 10 秒写 `data/runtime.json`（闸门占用、在跑工单、待答卡片、adhoc 计数、pid、时间戳）。顺带给看门狗一个比「443 连接存在」更可信的存活判据。

### 决策 2：热更新 `.env` 怎么生效
- 控制台改的是文件，daemon 的 `process.env` 是另一个进程的内存。需要 daemon 侧一个「重读」动作：控制台写完 `.env` 后写 `data/env.reload`，daemon 的 10 秒轮询看到就重新解析 `.env`，按键分三档处理：
  - **热生效**：所有按调用读的键（上面列的 Bitable / Wiki / Jenkins / GitLab / 模型开关）直接覆盖 `process.env`；`PIPELINE_PROJECTS` 走 `commitProjectsEnv` 同一条路原地替换项目表。
  - **需重启**：飞书三键、并发数、两个路径、webhook 端口。页面上这些字段标「改后需重启」，保存后给出重启入口，不偷偷生效一半。
  - **代码常量**（`STAGES`）：见决策 4。
- 与 `/bind`、`/addproject` 的并发：两边都用 `readEnvVar` / `upsertEnvVar` + 整份备份，daemon 重读时整份解析，两边写的值天然一致。页面保存时带上读取时的文件 mtime，mtime 变了就拒绝并提示重新加载（乐观锁）。

### 决策 3：热重启
- 按钮 = 写 `data/daemon.stop`，与今天的部署流程完全一致，不另造一套。
- 页面要把已知约束摆出来：daemon 在等 N 个会话结束（从心跳读）；距上次 RESTART 不足 10 分钟看门狗会跳过；空窗约 2 分钟内群里的消息会丢；看门狗只在有人登录时跑。
- 做不到的：强杀（提权进程，与现状同）；在有会话执行时立刻重启（刻意不做，会打断阶段会话）。

### 决策 4：各阶段模型 / 轮数 / 预算要不要可编辑
- 这些数字今天在代码里，每个都附着实测校准依据，改动走 git 有留痕、有评审。
- **推荐第一期只读展示**（连同注释里的理由一起显示）。如果确实要在页面改，做成 `config/stages.json` 覆盖文件、热读、页面显示「已覆盖默认值」，并在群里公告（与 `PIPELINE_IMPLEMENT_MODEL` 同一条纪律：静默换参会让指标失去可比性）。

### 决策 5：谁能访问、凭据怎么显示
- 凭据值永不下发到浏览器：页面只显示「已配置 / 未配置 + 长度」（`doctor.ts` 的口径），修改是只写字段（留空 = 不改）。
- 访问控制三档：
  - 只绑 127.0.0.1，本机 RDP 打开：零鉴权工作，但你从自己电脑打不开。
  - **绑内网 + `.env` 里一个 `CONSOLE_TOKEN`，首次访问输一次、cookie 保存（推荐第一期）**：内网明文 HTTP，token 等价于管理员权限，接受度需要你确认。
  - 飞书扫码登录 + 按 open_id 授权：能审计「谁改的」，第三期再做。
- 端口：新开一个（如 :8378），不与 webhook 混——webhook 依赖 GITLAB_* 才起得来，控制台不该被它绑定。

### 决策 6：技术栈
- 现在的运行依赖只有飞书 SDK 和 ajv。推荐第一期零新增运行依赖：`node:http` 提供 JSON API + 静态文件，前端一个 vanilla 单页（`web/` 目录），markdown 渲染用 vendored 的 marked。页面规模是几张表 + 几个表单，够用。
- 如果你希望它长成真正的产品面板，再换 Vite + React；先别为不确定的未来引入构建步骤。

### 决策 7：写操作的边界
- 已在飞书里有指令的操作（/bind /addproject /pause /resume /pool /dashboard），页面要**复用同一批纯函数**，不复制逻辑。
- 第一期写操作只做四件：改 `.env`、改项目表、重启、暂停 / 恢复工单（暂停已是文件协议，零改动）。需求的状态流转（确认 / 排期 / 搁置）继续在飞书卡片里走——那些动作要 @ 人、要发群，页面上点了没人知道。

## 3. 页面清单（第一期）

1. **总览**：daemon 存活（心跳 + pid + 上次 RESTART）、闸门占用、在跑工单、待答卡片、今日成本；一键「体检」（跑 `doctor.ts --no-infer`，逐行显示）。
2. **环境配置**：按 `.env.example` 的分组显示；凭据只显示状态；每个字段标「热生效 / 需重启」；保存 = 备份 + 改行 + 写 reload 信号；乐观锁。
3. **项目配置**：结构化表单（alias、repo、prefix、gitlab、jenkins、wiki 两节点、chatId、owner），校验复用 `validateNewProject`；保存走 `commitProjectsEnv` 同一路径。
4. **重启**：状态说明 + 按钮 + 进度（心跳消失 → 看门狗 RESTART 行 → 心跳恢复）。
5. **任务**：按项目分组列表（阶段、状态、成本、等待中的卡）；详情 = 事件时间线 + 各阶段 runs 表（模型、轮数、成本）+ pendingGate + 到文档的链接；暂停 / 恢复。
6. **需求**：需求池列表（状态、提出人、建议拆分、关联工单）；详情 = 需求说明 markdown、澄清问答、事件。
7. **文档**：选项目 → 选工单 → 文件列表 → markdown 渲染；prototype 走现有 `/preview/` 路由；项目级 PROJECT-BRIEF / PIPELINE.md / 系统地图。
8. **日志**：`daemon.log` / `watchdog.log` 尾部，可按关键词过滤（不做实时推送，轮询即可）。

## 4. 分期

- **P1**：控制台进程 + 心跳 + 上面 8 页（写操作四件）。daemon 侧改动很小：心跳落盘、reload 信号处理。
- **P2**：阶段参数覆盖文件、日志实时、从页面发起「继续 / 回退」（这些今天要经过飞书卡点，得想清楚通知谁）。
- **P3**：飞书登录、操作审计（谁在何时改了哪个键，值不记）。

## 5. 风险与已知限制

- 空窗丢消息与看门狗只在登录态运行，是重启机制本身的限制，页面解决不了，只能把它说清楚。
- `.env` 备份进 `backups/`（已 gitignore）；绝不生成 `.env.bak-*` 之类留在仓库根的文件。
- 控制台读各项目仓库的 `docs/pipeline/`，仓库路径来自项目表，路径解析必须锁在 `docs/pipeline/` 之内（同 `/preview/` 的穿越防护）。
- 页面与 daemon 的时钟 / 数据视图都是文件级最终一致，会有最多 10 秒的滞后，UI 上标出「更新于 N 秒前」。

## 6. 待你拍板

1. 访问方式：内网 + token（推荐），还是先只本机？
2. 阶段模型 / 预算：第一期只读（推荐），还是要可改？
3. 第一期写操作只做「配置 / 项目 / 重启 / 暂停」是否够？
4. 技术栈：零依赖 vanilla（推荐），还是直接 React？
