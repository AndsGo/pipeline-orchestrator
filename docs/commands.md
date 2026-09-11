# 指令与脚本参考

## 群内指令

在飞书群里 @机器人。斜杠命令确定性解析、零成本；不带斜杠的自然语言经模型分类（约 $0.02），**改变流程走向的（改需求/回退）会先弹确认卡**。在**话题**里 @机器人不用写工单号或 `/re`——话题就是那次会话或那张工单；话题里不 @ 的讨论会攒着，下次 @ 时一并带上。

### 工单

| 指令 | 作用 |
|---|---|
| `/new <需求原文>` | 新建工单并开跑，自动编号（`LS-014`）。也可 `/new LS-020 <需求>` 指定工单号，或 `/new 仓库D:/work/x <需求>` 指定仓库 |
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

PowerShell 包装：`.\scripts\start-ticket.ps1 -Repo D:/work/x -Ticket LS-003 -Requirement "…"` / `-Start review` / `-Lane fast`。

### 服务

| 命令 | 作用 |
|---|---|
| `npm run daemon` | 常驻编排器 |
| `npm run webhook` | GitLab MR 评论评审服务 + 结果预览页（:8377） |
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
| `bitable-backfill.ts [工单…]` | 回填历史工单进看板（幂等） |

### 迁移与修数（幂等，一次性）

`branch-migrate.ts`、`project-migrate.ts`、`kb-status-migrate.ts`、`delivery-link-fix.ts`、`sheet-writeback.ts`（子进程入口，不直接调）。

### 探针（只读，核实"到底成没成"）

`classify-probe.ts` / `classify-debug.ts`（意图识别）、`jenkins-probe.ts`、`wiki-probe.ts`、`msg-probe.ts`（群消息读取权限）、`doc-probe.ts`（Markdown → 云文档链路）、`e2e-port-test.ts`（飞书端口真机联调）、`gate-preview.ts <repo> <ticket> <gate>`（预览卡点决策材料）、`slash-preview.ts`（斜杠指令确认卡文案）、`list-check.ts`、`project-check.ts`。

### 进程脚本（PowerShell）

| 脚本 | 作用 |
|---|---|
| `start-daemon.ps1 [-Stop]` | 启停 daemon（含单实例检查、日志轮转、停止信号） |
| `start-watchdog.ps1 [-Stop]` | 以循环方式跑看门狗（不随开机自启；开机自启用 `schtasks`，见 [operations.md](operations.md#看门狗)） |
| `daemon-watchdog.ps1` | 看门狗本体（计划任务调它） |
| `start-webhook.ps1 [-Stop]` | 启停 webhook 服务（有 pid 文件时看门狗一并守护） |
| `start-ticket.ps1` | `npm run orchestrate` 的包装 |
