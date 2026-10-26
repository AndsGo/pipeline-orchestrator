# 指令与脚本参考

## 动态选择 Agent CLI

Web「执行配置」可保存多套 Codex、Claude Code、OpenCode 配置，并设置全局默认、项目默认及各入口覆盖。新建配置默认选择「模型与推理强度跟随 CLI」：编排器不传模型/effort 覆盖参数，忽略流水线模型环境变量；CLI 决定新任务及原生续聊的实际模型，续聊可能保留原会话的模型。登录、服务地址及原生内部默认选择/回退继续由 CLI 管理。编排器调用失败会明确报错，不自动换备用 CLI 或模型重跑。

保存配置为草稿，首次验证通过后即可选择；保存选择规则无需重启，对新任务生效。已有工单/Thread 继续使用保存的 CLI 和策略，工单可通过「切换执行配置」在阶段边界切换。跨 CLI 无法直接恢复原 session。固定模型的历史配置及快照不会自动迁移。

跟随策略仅排除已识别的主会话默认模型/推理强度字段。CLI 版本、权限、凭据、供应商、角色及项目配置仍参与校验；OpenCode 的模型字符串切换供应商、角色模型或供应商内部配置变化仍需重新验证。动态模型验证证明当次选择的兼容性，后续不兼容会明确失败。运行记录区分跟随策略与启动时报告的模型，CLI 未提供可信元数据时标为未报告；启动模型不代表 CLI 中途原生回退后的最终模型。Codex 跟随模式下不使用固定模型单价表估算费用，没有原生金额时显示费用未知。

原有 Codex 固定模型配置继续使用快照中明确指定的模型，推理强度显式设置时由流水线指定，否则随 CLI 当前配置。旧验证记录和旧会话保持原校验规则，重新验证不会自动改写旧会话。配置检查失败会说明原因，重发或改用 `/run` 不会解除检查。

## 群内指令

在飞书群里 **必须 @机器人** 才会处理消息：包括斜杠命令、自然语言、话题内的“继续”和文字答卡。未 @ 的讨论及附件不触发执行，也不攒到之后的指令中；@ 同事不算 @机器人。卡片按钮仍可直接操作。斜杠命令确定性解析、零成本；不带斜杠的自然语言经模型分类，**改变流程走向的（改需求/回退）会先弹确认卡**。在**已绑定的话题**里 @机器人不用写工单号或 `/re`。

### 需求池

业务提的需求先进池，不直接建单（设计稿 `docs/design/2026-09-23-requirements-pool.md`）。自然语言描述一个新功能/改进（「我想要…」「能不能加个…」）默认走这里。

| 指令 | 作用 |
|---|---|
| `/req <一句话需求>` | 开一条需求（`REQ-001`）：bot 在话题里访谈、调研（最多 3 轮），出《需求说明》→ 提出人确认 → 负责人排期 → 按建议拆分自动建单。会话话题里说「整理成需求 / 进需求池」则以该话题为来源，前面聊的都算数 |
| `/pool` | 需求池一览（梳理中 / 待确认 / 待排期 / 已排期 / 已转工单，带天数） |

- 排期卡只认项目负责人（`PIPELINE_PROJECTS` 的 `owner`；没配则谁都可以点）。确认卡认提出人和负责人
- 每项目同时在制最多 2 张工单（闭环、挂起、7 天没动静的不算），满了就排队，有单闭环自动出队
- 工单闭环后在需求话题里 @ 提出人；待排期超 14 天没动，@ 负责人提醒一次
- daemon 重启后，7 天内的待确认 / 待排期卡按状态重发

### 工单

| 指令 | 作用 |
|---|---|
| `/new <需求原文>` | 直接新建工单并开跑、不经过需求池（开发自用），自动编号（`LS-014`）。也可 `/new LS-020 <需求>` 指定工单号，或 `/new 仓库D:/work/x <需求>` 指定仓库 |
| `/new`（不带正文）或「按刚才聊的建单」 | 把最近的 `/run` 整段对话压成需求原文，弹卡确认后建单 |
| `/status <工单>` | 时间线卡：节点、成本、回环、挂起原因、当前在等什么 |
| `/list` | 全部工单一览（在跑 / 挂起 / 等人工 / 闭环） |
| `/dashboard` | 运行面板：常用链接 + 运行情况 + 工单一览 + 质量指标 |
| `/pause <工单>` / `/resume <工单>` 或「继续 LS-014」 | 下一个安全点暂停 / 继续。重启后失效的卡片、被打断的阶段都用「继续」恢复 |
| `/amend <工单> <改成…>` | 修改/追加需求，写进 `00-intake.md`，回退到澄清重跑（有确认卡） |
| `/rewind <工单> <阶段> [原因]` | 回退到指定阶段重跑（`clarify / plan / implement / review / ci / acceptance`），下个安全点生效 |
| `/note <工单> <说明>` | 追加一条说明，下个阶段读到（不回退）。闭环工单会提醒「不会被自动处理」 |

### 单次执行

| 指令 | 作用 |
|---|---|
| `/run <一句话>` | 只读排查、分析、查数、出报表。有 Bash、无写工具、不建工单不入看板。结尾的编号问题可直接回复续聊 |
| `/run /<斜杠指令>` | 跑项目或个人的斜杠指令 / skill（斜杠要在最前面）。先弹确认卡，写清会跑什么、有什么对外副作用 |
| `/re <答复>` 或直接回话、或引用结果卡回话 | 续上一次 `/run`（真续会话）。引用哪张结果卡就精确续哪次；`/re` 撞上过期指针会列出再往前一次问你要不要接 |

### 项目与群

| 指令 | 作用 |
|---|---|
| `/addproject <别名> <仓库路径> <前缀> [gitlab=组/项目] [jenkins=任务名] [wiki=节点]` | 接入新项目，写进 `.env` 并热加载；生成 `PIPELINE.md` 模板；回执点名 `.gitignore` / `CLAUDE.md` 问题 |
| `/bind <别名>` | 把**当前群**绑定为该项目的群（在目标群里发）。此后该群消息默认归它，工单通知也发到这里。主群不可绑 |
| `/use <别名>` / `/use` | 本群后续几小时默认按该项目处理 / 查看当前 |
| `/help` | 指令帮助 |

### 回答卡片

| 写法 | 含义 |
|---|---|
| 点按钮 | 最省事，推荐项高亮 |
| `通过` / `不通过 实际是页面报 500` | 单项待答时直接答，余下文字作补充说明 |
| `Q2 不通过 …`、`Q1 Q3 通过` | 多项待答时指明 |
| `全部通过` / `都无法验证` | 一次答完所有匹配项。后面跟的新需求（「但是我还想…」）会被拆出来问要不要开新单 |
| `驳回 计划漏了限流` | 卡点卡的通过/驳回 + 理由 |

## 命令行

### 单工单一次性运行（调试 / 无人值守）

```bash
npm run orchestrate -- <repoPath> <ticketId> [--start <stage>] [--requirement "…"] [--lane fast|full] [--feishu|--auto]
```

| 参数 | 说明 |
|---|---|
| `--requirement` | 全新工单必填（自动创建 `00-intake.md`） |
| `--start <stage>` | 断点续跑，从指定阶段继续 |
| `--lane fast\|full` | 跳过分诊，强制通道 |
| `--feishu` | 用飞书端口交互（需 `FEISHU_*`） |
| `--auto` | 无人值守：采纳推荐答案、卡点自动放行、验收人工项答「无法验证」 |
| （都不给） | CLI 端口，终端里问答 |

脚本包装（后台起、日志落 `logs/<工单>.log`）：

```bash
scripts/start-ticket.sh --repo /work/x --ticket LS-003 --requirement "…"     # Linux / macOS
scripts/start-ticket.sh --repo /work/x --ticket LS-003 --start review
.\scripts\start-ticket.ps1 -Repo D:/work/x -Ticket LS-003 -Requirement "…"  # Windows
```

### 服务

| 命令 | 作用 |
|---|---|
| `npm run daemon` | 常驻编排器 |
| `npm run web` | web 服务：GitLab MR 评论评审 + 结果预览页 + 控制台（:8377）；生产用 `start-web.*` 起 |
| `npm run pause -- <工单>` | 下发暂停信号 |
| `npm test` / `npm run typecheck` | 测试 / 类型检查 |

## 运维脚本

全部 `npx tsx scripts/<name>.ts`，自己装载 `.env`，不回显密钥。头三行注释是用法。

### 日常

| 脚本 | 作用 |
|---|---|
| `doctor.ts [--no-infer]` | 体检：依赖 / 配置 / 连通性 / daemon 存活；任何 ❌ 退出码 1 |
| `add-project.ts [--alias --repo --prefix --gitlab --jenkins --wiki --dry]` | 接入新项目向导（终端版，群里用 `/addproject`） |
| `system-map.ts --check\|--rebuild\|--publish [别名]` | 能力地图：新鲜度报告（零成本）/ 全量重建（$3–6）/ 发布到飞书 |
| `kb-refresh-audit.ts` | 知识库老化报告（daemon 每 30 天自动发一次） |
| `model-experiment.ts` | implement 模型对照实验读数 |
| `skill-eval.ts --all\|<场景>` | 跑 pipeline-plugin 的评估集（约 $1/全量） |

### 一次性建表（多维表格 / 知识库）

| 脚本 | 作用 |
|---|---|
| `bitable-setup.ts [看板名]` | 建多维表格 + 工单表 + 节点表，打印三行配置写进 `.env` |
| `kb-setup.ts` | 加「交付文档」字段与「知识」表，建两个 wiki 归档节点（幂等） |
| `glossary-setup.ts` | 建「术语」表 |
| `req-setup.ts` | 建「需求池」表，打印 `BITABLE_REQ_TABLE_ID` |
| `bitable-backfill.ts [工单…]` | 回填历史工单进看板（幂等） |

### 迁移与修数（幂等，一次性）

`branch-migrate.ts`、`project-migrate.ts`、`kb-status-migrate.ts`、`delivery-link-fix.ts`、`sheet-writeback.ts`（子进程入口，不直接调）。

### 探针（只读，核实"到底成没成"）

`classify-probe.ts` / `classify-debug.ts`（意图识别）、`jenkins-probe.ts`、`wiki-probe.ts`、`msg-probe.ts`（群消息读取权限）、`doc-probe.ts`（Markdown → 云文档链路）、`e2e-port-test.ts`（飞书端口真机联调）、`gate-preview.ts <repo> <ticket> <gate>`（预览卡点决策材料）、`slash-preview.ts`（斜杠指令确认卡文案）、`list-check.ts`、`project-check.ts`。

### 进程脚本

每个都有 PowerShell（Windows）与 bash（Linux / macOS）两版，行为一致；`-Stop` ↔ `--stop`。

| 脚本 | 作用 |
|---|---|
| `start-daemon.ps1 [-Stop]` / `start-daemon.sh [--stop]` | 启停 daemon（单实例检查、`.env` 装载、日志轮转、启动核实、停止信号） |
| `start-watchdog.ps1 [-Stop]` / `start-watchdog.sh [--stop]` | 以循环方式跑看门狗（不随开机自启；开机自启用 `schtasks` / cron，见 [operations.md](operations.md#看门狗)） |
| `daemon-watchdog.ps1` / `daemon-watchdog.sh` | 看门狗本体（计划任务 / cron 调它） |
| `register-watchdog.ps1 [-S4U]` | 注册 / 更新看门狗计划任务（管理员终端；无窗口；`-S4U` 不登录也运行） |
| `start-web.ps1 [-Stop]` / `start-web.sh [--stop]` | 启停 web 服务（有 pid 文件时看门狗一并守护；杀不动时写停止信号） |
| `start-ticket.ps1` / `start-ticket.sh` | `npm run orchestrate` 的后台包装 |
| `_lib.sh` | bash 版共用函数（`.env` 装载、进程树、日志轮转），不单独执行 |
