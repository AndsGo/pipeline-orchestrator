# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本号在 0.x 阶段：次版本 = 一批面向用户的能力，补丁位 = 修复。每条尽量注明它来自哪张真实工单。

## [Unreleased]

### 文档
- 开源化：README 重写，新增 LICENSE（MIT）、CONTRIBUTING、SECURITY、CHANGELOG，`docs/` 下入门 / 配置 / 架构 / 运维 / 排障 / 指令参考六篇，GitHub issue / PR 模板；`.env.example` 补 Codex 引擎相关键；`package.json` 补元数据。

## [0.3.0] — 2026-09-11

### 新增
- **话题只 @ 才触发**：话题里不 @ 机器人的话不触发、不回复，攒着（20 条 / 24 小时）随下一次 @ 一并交给会话或工单；只有能承载文字的指令才取走攒下的话；确认改为表情回应。
- **话题里的文件与图片**：话题里直接甩的文件/图片下载到本地进「攒着」队列；@ 时一律带上群置顶文件。
- **在线电子表格附件夹与嵌图**：会话图片放 `sheet/assets/`，编排器上传到云空间；整格等于图片文件名的直接嵌进单元格。
- **无声退出探针**：`start-daemon` 外层记录 node 退出码、开 `--report-on-fatalerror`（`logs/reports/`），区分「自己崩」与「被外力杀」。

### 修复
- 在线表写回移到子进程——大批量嵌图三次让 daemon 无声退出（0xC0000409）；写回检查点先落盘，子进程收尾崩也按已写回处理。
- 话题里不弹低置信确认卡；停止信号遇挂着的卡片最多等 5 分钟再退。
- 会话话题里分类器猜的 `new` 按续聊处理——同事一句对提示词的意见曾被判成新工单。
- 表情回应用合法的 emoji_type；遇 231003（消息已撤回）不告警。

## [0.2.0] — 2026-09-10

首个正式版本号。此前一直是 0.1.0。

### 新增
- **话题 = 会话**：飞书话题维度的上下文——话题绑会话或工单，回应回到发问处；工单话题默认开，广播复制进话题；30 轮 / 7 天寿命。设计稿 `docs/design/2026-09-09-thread-context.md`。
- **业务受众口吻**（`PIPELINE.md` `audience: business`）：编排器写死的群消息模板改说人话、带「走到第几步」锚与下一步动作。
- **待复核状态门**：阶段回报 `stale_hints` 的知识条目当刻标「待复核」停注入，闭环时发卡定夺（契约 0.12.0）。
- **会话出件箱**：会话要交给人的文件由编排器上传发进群/话题；验收 e2e 截图随结果卡。
- **在线电子表格**：会话表格产物落为飞书在线表，机器人建表、人和会话同写一张；多工作表每页一个 csv。
- 意图识别带上本群最近一次 `/run`，回应它的话判续聊；续聊里要求「建成工单」按对话草拟需求。
- **浏览器 e2e 开关**（`e2e: playwright`）：验收/评审阶段带 Playwright MCP，claude 与 codex 两引擎都接。

### 修复
- runner 提示词改走临时文件 + stdin 重定向——拼进 `bash -c` 命令行超约 8190 字符被截。
- Codex e2e 评审不再同传 `-s` 与 `--approve-for-me`（CLI 判互斥）。
- 看门狗：重启机器后旧 pid 被复用时不再误判 daemon 存活；`start-daemon` 结论用 `*>&1` 捕获。
- 有工单正等着卡片答复时不再提供 followup——开着的卡强于几小时前的 `/run` 指针。
- 结果卡先发、在线表写回后做——写回可能数分钟，人不该盲等。

## [0.1.0] — 2026-08-15 … 2026-09-07（未打 tag 的演进期）

按主题归并，时间正序。

### 2026-08-15 ～ 08-19：入库与守护
- 编排器入库（含单元一改造：四态契约、状态机、飞书端口、事件流）。
- daemon 看门狗：死了拉起，长连接僵死且无在跑会话时重启；守护正式化（计划任务注册、webhook 纳管、备份与日志防膨胀）。
- 业务术语表全链路；度量与治理（评审一次通过率 / 修复轮 / 验收返工）；CLAUDE.md 采纳改走「专用分支 + MR」。
- 阶段会话禁用抢流控的插件层（`config/pipeline-settings.json`）；评审双轴契约 + skill 评估集运行器。
- `/run` 续聊：轻量续聊协议 → 改 `--resume` 真续会话（零信息损失，成本约降十倍）；引用消息、合并转发、引用图片/文件可达。
- 修复：修复轮 `NEEDS_CONTEXT` 三连修（LS-008）；`/run` 提示词钉死中文输出（曾整段韩语进业务群）；`side_effect` 覆盖 git 结构性操作。

### 2026-08-21 ～ 08-26：自续跑、地图、多项目
- implement 执行余量用尽时自动续跑下一批，不再每批等人点「继续」；续跑判据认 worktree 里的台账。
- 未消化的 BLOCK 阻断项不许纯重试（LS-012 三条评审教训）。
- 模型配置：clarify 换 opus、预算 $8→$16；plan 轮数与预算按实测抬到 120/$14；钉住推理档位。
- implement 模型对照实验机制与读数器（`PIPELINE_IMPLEMENT_MODEL`、`scripts/model-experiment.ts`）。
- 能力地图（system-map）：新鲜度判据、注入头、维护脚本、发布覆盖同一篇。
- 多项目：`PIPELINE_PROJECTS` 注册表、从消息文本认项目、全局 `JENKINS_JOB` 不再兜底；`add-project` 向导 + `doctor` 体检。
- 知识库月度老化审计制度化；三项闭环补漏（建单自动附带排查结论、「继续 <工单>」识别、开机中断巡检）。
- 修复：compound 白名单补 Edit + 轮数/预算抬到 100/$8；bitable 工件目录与产物链接从来打不开；知识库搬迁是异步的。

### 2026-08-31 ～ 09-02：群内接入、原型、卡点持久化
- 群内 `/addproject`；项目粘性 `/use` + 群↔项目绑定 `/bind`；开机点名重启前失效的待答卡片（7 天时效护栏）。
- **结果预览**：PRD 确认前生成业务可看的 HTML 原型页（`pipeline-prototype` skill + 预览路由）。
- ONBOARDING 新人上手指南。
- **卡点持久化**：重启后重发未答的卡，而不是无声跳过（此前弹卡前就推游标落盘，「继续」会跳过审批直接写代码）。
- **停止信号文件** `data/daemon.stop`：普通 shell 也能让提权 daemon 在空闲时自退。
- **聊完即建单**：`/run` 对话累积进指针，空 `/new` 由对话草拟需求弹卡确认后建单。
- **瞬时 API 故障自动重试**：529 / 网关 / 连接抖动等 3 分钟重跑一次。
- 修复：提权 daemon 的三处误判（doctor 判活、`-Stop` 假报、看门狗备份被单文件拖垮）；Windows 孤儿 claude 检测改走 `-EncodedCommand`；台账完成行容忍反引号/星号开头（OP-002 1/4 被数成 0/4）；富文本 `/new` 优先按结构化 runs 解析；doctor 检测 `.gitignore` 屏蔽工件目录。

### 2026-09-03 ～ 09-07：项目约定、上线环节、引擎抽象、架构稳固
- **项目流程约定** `docs/pipeline/PIPELINE.md`：同一套流水线按项目走不同的测试 / 验收 / 上线（`testEnv` / `acceptor` / `release`），六个 skill 先读节选。
- **上线环节**：`release-approval` 卡点；合并前拉目标分支干跑合并查冲突；上线后补验卡异步不阻塞 compound；GitLab 合并 405 但已 merged 判成功（LS-015）。
- **执行引擎接口**：claude 原生 + codex 桥接，按 `engine` / `engine.<stage>` 选。Codex 四道坎：严格结构化输出（全属性 required、可选变可空、只剥原本可选字段的 null）、起进程不经 shell、工件写回 worktree、事件如实标引擎。
- **架构稳固**：`runTicket` 拆成 `src/run/` 七模块（647→169 行）；daemon 16 个 case 拆成 `src/daemon/handlers/`，开机巡检与定时任务移入 `boot.ts` / `lifecycle.ts`；runTicket 集成测试夹具（假引擎 + 脚本化端口，7 场景）；指令处理器单测 19 例。
- followup：结果卡 ↔ 会话映射 + 按群续聊指针（引用哪张卡续哪次）；`/re` 撞上过期指针列出上一次问要不要接；引用卡片消息时抽出卡片文字。
- 修复：「全部通过，但是…新需求」不再灌进每项备注；doctor 检测 `.gitignore` 屏蔽 `CLAUDE.md`；停止信号的「空闲」改为无会话在执行。

[Unreleased]: https://github.com/AndsGo/pipeline-orchestrator/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AndsGo/pipeline-orchestrator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AndsGo/pipeline-orchestrator/releases/tag/v0.2.0
