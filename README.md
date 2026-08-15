# pipeline-orchestrator

飞书 + Claude Code 开发流水线的编排服务（MVP）。把 LS-001 试跑中人工编排的全部动作固化为代码：状态机路由、headless 会话调度、回程校验、人工卡点与问答回填。

## 运行（推荐：常驻 daemon，全程在飞书群里操作）

```powershell
copy .env.example .env      # 填 FEISHU_* 与 PIPELINE_REPOS
.\scripts\start-daemon.ps1  # 启动（自带冲突检查：一个飞书应用只能一条长连接）
.\scripts\start-daemon.ps1 -Stop
```

之后在群里 @bot：

| 说什么 | 效果 |
|---|---|
| `/new LS-004 <需求原文>`　或直接描述一个新需求 | 建单并开跑（自动分诊快车道/全流水线） |
| `/status LS-004`　"现在到哪了" | 时间线卡片：节点、成本、回环次数、挂起原因 |
| `/list` | 所有工单一览（在跑/挂起/空闲） |
| `/amend LS-004 <改成……>`　"这个需求改一下：…" | 需求变更写进 `00-intake.md`，自动回退到澄清重跑 |
| `/rewind LS-004 plan <原因>`　"退回去重做计划" | 回退到指定阶段重跑（下个安全点生效） |
| `/note LS-004 <说明>` | 追加一条说明，下个阶段读得到（不回退） |
| `/pause LS-004` / `/resume LS-004` | 安全点暂停 / 继续（暂停期间可用 lark-channel-bridge 交互式接管现场） |

自然语言指令经 Haiku 分类；**破坏性指令（改需求/回退）会先弹确认卡片**，避免误识别改变工单走向。

## 运行（单工单一次性模式，调试用）

```bash
npm install
# 全新工单（自动创建 00-intake.md）
npm run orchestrate -- D:/work/lake_spirit LS-002 --requirement "需求原文……"
# 断点续跑（挂起处理后从指定阶段继续）
npm run orchestrate -- D:/work/lake_spirit LS-002 --start review
# 无人值守（采纳推荐答案、卡点自动放行、验收人工项答"无法验证"）
npm run orchestrate -- D:/work/lake_spirit LS-002 --auto
# 飞书交互（卡片提问 / 卡点审批 / 进度通知）
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx FEISHU_CHAT_ID=oc_xxx \
  npm run orchestrate -- D:/work/lake_spirit LS-002 --feishu
```

依赖：`claude` CLI 在 PATH 中；`pipeline-plugin` 与本目录平级（或设 `PIPELINE_PLUGIN_DIR`）。

## Jenkins CI 阶段（可选）

设置以下环境变量后，**新建的工单**在 review 通过后会插入「上线审批卡点 → Jenkins 构建」再进验收；不设置则保持 review → 验收直达。是否走 CI 在建单时固化进工单状态，中途改环境变量不影响在途工单。

```bash
JENKINS_URL=http://jenkins.internal:8080
JENKINS_JOB=deploy/my-app          # 支持 folder/job 形式
JENKINS_USER=ci-bot
JENKINS_TOKEN=<API Token>          # 用户 API token（免 CSRF crumb）
JENKINS_TIMEOUT_MIN=30             # 可选，默认 30 分钟
```

约定：编排器以 `buildWithParameters` 触发，传参 `TICKET`（工单号）与 `BRANCH`（当前 feature 分支）——Jenkins 任务需声明这两个参数并按 BRANCH 检出构建。构建失败 → 工单挂起（日志尾部记入 `35-ci.md`），修复后 `--start ci` 重试。

## 飞书应用配置（--feishu 前置，一次性）

1. 开放平台建**自建应用**，开启机器人能力
2. 权限：`im:message`（发消息）、`im:message.group_at_msg`（可选）
3. 事件订阅选择**长连接模式**（免公网回调），添加回调 `card.action.trigger`
4. 发布应用 → 把机器人拉进目标群 → 取群 `chat_id`（oc_ 开头）填 `FEISHU_CHAT_ID`
5. 注意：长连接多实例不广播——编排器保持单实例部署

## 结构

| 模块 | 职责 |
|---|---|
| `daemon.ts` | **常驻编排器**：唯一飞书长连接 + 多工单并行 + 群内指令通道（斜杠命令 / 自然语言） |
| `ticketRunner.ts` | 单工单生命周期（分诊 → 快车道/全流水线 → 闭环），cli 与 daemon 共用 |
| `commands.ts` | 指令解析：斜杠命令（确定性、零成本）+ Haiku 自然语言分类 + 破坏性指令确认 |
| `events.ts` | **节点级事件日志**（`data/<ticket>.events.jsonl`，append-only）：每个节点的开始/结束/人工输入/回退都留痕，`/status` 从它渲染时间线；`onEvent` 供旁路消费者订阅 |
| `bitable/` | **多维表格看板投影**：事件 → 工单表（看板视图）+ 节点表（每阶段产物/决策/成本/产物直链）。只读投影、异步旁路、失败进 outbox，绝不阻塞流水线 |
| `feedback.ts` | 人工反馈落盘（`feedback.md` / `00-intake.md` 需求变更），阶段重跑时以 `feedback=` 传入 |
| `workspace.ts` | 并行工作区：同仓库第二个工单起自动开 git worktree 隔离 |
| `semaphore.ts` | claude 会话并发闸门（`PIPELINE_MAX_CONCURRENCY`） |
| `machine.ts` | **路由核心（纯函数）**：四态 + verdict → run / ask / gate / fix / halt / done；配了 Jenkins 时 review 通过 → 上线审批 → ci |
| `jenkins.ts` | CI 阶段（编排器原生，不花 LLM）：buildWithParameters（API token 免 crumb）→ queue item 换 build number → 轮询结果 → 失败取日志尾部；构建记录落工单 `35-ci.md` |
| `config.ts` | 各阶段工具白名单/模型/轮数/预算（LS-001 实测校准）；修复回环上限 2 |
| `runner.ts` | spawn `claude -p /pipeline-<stage>`，线上版 schema 内联，stdout 抗噪解析 |
| `schema.ts` | 完整 schema 回程校验（ajv）；wire 版剥顶层 allOf（API 限制） |
| `ports.ts` | 交互端口抽象：`CliPort`（终端）、`AutoPort`（无人值守：采纳推荐/自动放行/验收诚实答"无法验证"） |
| `feishu/` | `FeishuPort`：官方 node-sdk WebSocket 长连接收 `card.action.trigger`（免公网），提问=选项按钮卡片、卡点=通过/驳回卡片、通知=群消息；`card.ts` 纯函数可单测 |
| `backfill.ts` | NEEDS_CONTEXT 回答按轮次追加进 00-intake.md / 40-acceptance.md |
| `ticket.ts` | 工单状态持久化（data/<ticket>.json）：游标、回环计数、成本台账 |
| `lock.ts` | 工单级 PID 锁（防双控制器）+ 孤儿 claude 进程检测；陈旧锁按 pid 探活自动接管 |
| `gitlab/` | webhook 入站服务：MR 评论含触发词 → 临时 worktree 独立 review（Opus，$10 封顶）→ 结论/findings 表格回帖 MR |

## GitLab MR 评审服务（独立于流水线）

```bash
GITLAB_URL=http://gitlab.internal \
GITLAB_API_TOKEN=<PAT，需 api 权限> \
GITLAB_WEBHOOK_SECRET=<自定义密串> \
GITLAB_REPO_MAP='{"group/proj":"D:/work/proj"}' \
GITLAB_TRIGGER=@ai-review \
  npm run webhook   # 监听 :8377/gitlab
```

GitLab 侧：项目 → Settings → Webhooks → URL 填 `http://<执行机>:8377/gitlab`，Secret token 填同一密串，勾选 **Comments (note events)**。之后任何人在 MR 评论里 @ai-review 即触发独立评审并回帖。执行机需已 clone 对应仓库且 `origin` 指向该 GitLab。

## 多维表格看板（可选）

一次性建板（需应用开通 `bitable:app` + `base:app:create` 并发布版本）：

```powershell
npx tsx scripts/bitable-setup.ts "流水线看板"   # 打印 3 行配置，写进 .env
npx tsx scripts/bitable-backfill.ts             # 回填历史工单（幂等，可反复跑）
```

启用后 daemon 会把每个事件投影到两张表：

- **工单表**（一行一工单）：当前阶段、运行状态（在跑/等人工/挂起/闭环）、通道、**当前在等**、累计成本、会话数、回环次数、分支、工件目录直链。看板视图按「当前阶段」分组即得 kanban。
- **节点表**（一行一次阶段运行或人工决策）：结果、结论、**摘要**（决策信息）、**人工决策**（驳回理由/逐题回答）、成本、轮数、**产物 GitLab 直链**，关联到工单行。

设计约束：事件日志是事实源，表格是**只读投影**——表结构改了可以 backfill 重投，投影失败进 `data/bitable-outbox.jsonl` 待重放，任何情况都不阻塞流水线。

## 人怎么参与（不只是点按钮）

- **每张卡片都带自由输入框**：问题卡片可写前提/异议，卡点卡片"驳回并说明"。这段文字写进工单 `feedback.md`，重跑该阶段时以 `feedback=` 传给会话，被当作**优先于旧结论的约束性指令**（契约见 pipeline-plugin handoff-spec §8）。
- **驳回 ≠ 终止**：PRD 驳回回退到澄清重跑、计划驳回回退到计划重跑（都带着你的意见），上线审批驳回=决定不发布→挂起。
- **随时插话**：群里 @bot 说"这个需求改一下…"就能改需求并自动回到澄清；说"退回去重做计划"就回退。破坏性操作先确认。
- **每个节点都有记录**：`/status` 看时间线（谁在什么时候答了什么、哪一步回退过、花了多少）。

## 分级与人工介入

- **分诊（P0）**：新工单先由 Haiku 分诊（约 $0.02）——`fast` 走快车道（单会话直接实现+自测+提交，$5 封顶），`full` 走全流水线。快车道发现超范围会 **ESCALATE 自动降级**回全流水线。强制指定：`start-ticket.ps1 -Lane fast|full`。
- **暂停/恢复（P1）**：`npm run pause -- LS-003` 下发暂停信号（bridge bot 可代执行），编排器在下一个阶段边界安全停住；重跑 start-ticket 即恢复。中途可用 bridge 交互式接管现场。
- **双评审取严（P2）**：环境变量 `PIPELINE_DOUBLE_REVIEW=1` 时 review 跑两轮独立评审，verdict 取严、分歧记入 concerns（对冲评审非确定性，约 +$3/单）。
- **实现期进度（P3）**：implement 阶段每 20 秒盯 ledger，任务完成/回环/挂起行实时推飞书。

## 后续（非阻塞）

- 多工单并发（git worktree 隔离 + 队列；当前串行）
- review 回帖升级为逐条行内 discussion（现为汇总表格单帖）
- Feishu 卡片流式进度（CardKit）
