# 上线闭环验证记录

2026-10-14 免费模型优先增量：OpenCode 未显式指定模型时冻结为 `opencode/space-bunny-free`，全局仍默认 Codex，旧工单与显式模型不变。47 个文件、598 项测试和类型检查、前端语法检查通过。[真实 run JSON 调用](evidence-index.md#2026-10-14t02-11-31-442z-opencode-free)通过，[原生会话模型记录](evidence-index.md#2026-10-14t02-11-31-442z-opencode-free)确认 provider 为 opencode、模型为 space-bunny-free。完整[用途验证](evidence-index.md#2026-10-14t02-11-31-442z-opencode-free)仅 JSON 通过，禁用工具的续聊被上游免费服务 403 拒绝；只读调用也被拒绝。未扩大入口权限、未改用付费模型、未激活生产免费配置、未重启服务。早期失败证据保留；恢复原有 Agent system 后 run 成功，单独恢复原生 system 未消除只读拒绝，因此没有引入临时 instructions 文件方案。Astra 咨询因工作区额度不足失败，本轮尚未完成 Astra 验收。

截至 2026-10-14 09:29（UTC+8）：**整体 NOT PASS，新代码尚未上线**。Claude 和 OpenCode 真实工单已闭环；默认配置已保存为 Codex，但真实 Codex 工单仍被本机沙箱阻挡，今早原生配置变化也使昨晚的身份验证失效。最终 Astra 统一验收待剩余任务完成后进行。

## 当前结果

| 项目 | 最新结论 | 证据 |
|---|---|---|
| Claude 完整工单 | 六阶段、原型、自动测试及四场景独立断言 PASS | [工单](evidence-index.md#2026-10-13t07-48-34-667z-real-ticket-resume) |
| OpenCode 完整工单 | 六阶段、原型、自动测试及四场景独立断言 PASS；保留阶段 concern | [工单](evidence-index.md#2026-10-13t14-22-56-769z-real-ticket-resume) |
| OpenCode 实现角色 | 三个独立原生子会话、明确模型、完成关联和原版 SDD helper 执行 PASS | [角色原始证据](evidence-index.md#2026-10-13t15-20-57-164z-opencode-roles) |
| Codex 默认 | 已保存 revision 3，`codex-default` / `gpt-6.1-sol` / native / unelevated | [保存及当时 13 入口预检](evidence-index.md#2026-10-13t14-53-31-024z-codex-default) |
| Codex 真实工单 | clarify、prototype 完成，plan BLOCKED，功能断言失败 | [工单](evidence-index.md#2026-10-13t14-21-01-019z-real-ticket) |
| 插件原有回归 | 真实 Claude 评审、验收 2/2 PASS，正确 BLOCK 未实现的 AC | [skill-eval](evidence-index.md#2026-10-13t14-53-20-600z-skill-eval) |
| 版本切换与数据保留 | 隔离的候选→HEAD 基线→候选读取，关闭快照保留 PASS | [最新回退演练](evidence-index.md#2026-10-14t01-36-42-820z-rollback) |
| 启动配置回读 | 昨晚 PASS；今早原生配置变化，身份校验阻止执行 | [昨晚](evidence-index.md#2026-10-13t15-29-47-499z-default-readback)、[今早](evidence-index.md#2026-10-14t01-28-05-265z-default-readback) |

工单报告中的 `ticketFlowStatus` 表示该 CLI 工单的结果；顶层 `status: NOT_PASS` 保留三引擎与 Astra 的整体门槛。隔离工单没有远端 MR、生产 CI 或部署，相关限制与 concern 保留在实际产物中。

OpenCode 父会话 `ses_ecb2a4725ffei15gyDyz3SnZo6` 的实现、任务评审、终审子会话依次为 `ses_ecb26ee52ffeC1s51WGEO09hYv`、`ses_ecb24eb17ffeXF97qdipfLaczv`、`ses_ecb229cbeffejROAgjTZasfrSW`。逐一核对原生派发参数、parent ID、工作目录、模型、完成时间、父收到的子结果与实际评审 PASS 标记。当前功能文件与已评审提交 `0e13fea` 无差异，后续整理提交没有改变实现；原版 SDD 6.4.1 三个 Bash helper 均有原生命令成功记录。实际模型是 `ollama/ornith-1.5:9b`，不宣称三种不同模型。

## Codex 阻塞与恢复条件

真实工单 `pipeline-full-ticket-020RUx` 沿用正式默认模型、原生推理档位与 3 小时阶段超时。unelevated 下 Bash 和原版 SDD helper 报 `couldn't create signal pipe, Win32 error 5`，原始 Node test worker 也受限；使用单进程测试不能替代原始验收。

本机 Windows 11 25H2 build 26200.9457 / Codex CLI 0.162.1 的 MXC 启动 canary 成功，但 Bash 报 `NtCreateDirectoryObject(\\BaseNamedObjects\\msys-...): 0xC0000022`，退出码 `0xC0000142`。[无模型诊断](evidence-index.md#2026-10-13t15-05-54-726z-codex-sandbox) 为 NOT_PASS。微软项目有较新 MSYS 3.6.5 的同类报告，因此不能推断升级 Git 即可解决本机问题：[MXC issue 1061](https://github.com/microsoft/mxc/issues/1061)。

elevated 刷新被正在使用的 `cua_node/b63ee7ee40c23b77/bin/node_repl.exe` 阻挡，Win32 error 32。2026-10-14 09:23 只读复查仍有同一组 5 个进程。经 Astra 咨询，09:27 实测仅对该次原生调用覆盖 `notify=[]` 和 `mcp_servers.node_repl.enabled=false`；仍在同一个 root-only ACL update 失败：[诊断及原生日志](evidence-index.md#2026-10-14t01-27-18-474z-codex-sandbox)。原生 refresh 已对隔离诊断仓库的 `.git` / `.agents` 设置保护 ACE；没有执行独立 setup、终止外部会话或保存这些临时配置覆盖。

后续需保存并正常关闭占用 runtime 的相关 Codex 会话，再按官方流程修复 elevated 环境。官方 setup 会配置沙箱账号、文件权限、防火墙并保存 sandbox 选择；已向用户说明影响，尚未执行。依据：[OpenAI Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)。环境修复后须实际运行原版 Bash/SDD、原始 Node 测试和读写权限 canary，再重新验证新 profile、显式切换原工单并完成真实实现、独立评审与收尾。

占用进程的实际父进程仍存活，均为 Codex CLI：PID 22780、6772、29180；父进程创建时间早于各自 node_repl 子进程，不能当作已退出会话留下的孤儿。已请求用户保存并正常退出这三个会话，等待完成后继续。

释放占用后先重跑无模型 elevated 工具链诊断，判断现有原生环境是否已经足够；只有仍需原生 provisioning 时才执行官方 setup。已为恢复脚本补齐显式模式选择：`activate-codex-default.ts --windows-sandbox elevated` 会创建独立命名配置、真实验证后再选择它，保留旧配置；`resume-real-ticket.ts --refresh-profile --windows-sandbox elevated` 会在真实重验证后排队显式阶段切换，保留原快照历史。它们仍分别要求 `--allow-model-calls --apply` 与 `--allow-model-calls`，尚未执行 elevated 激活或恢复。

最新 `diagnose-codex-sandbox.ts` 使用单独诊断仓库、原始 skill/计划/测试和 canary 提交范围，不向真实工单伪造提交或改写阶段结果。它证明工具链是否可运行，不证明业务功能通过。

## 默认配置与运行态

源码和生产配置默认已改为 Codex。`.env` 的 `PIPELINE_CODEX_HOME` 绑定 Orca 原生 home，未复制认证文件。昨晚按看门狗脚本相同方式读取 `.env` 后，13 入口与原生身份均通过。今早 09:03:45 原生 `config.toml` 被外部更新为 `model=gpt-6-astra`、`model_reasoning_effort=low`；账户、CLI 路径/版本匹配，认证文件最后写入时间仍早于昨晚验证。流水线 profile 仍明确指定 `gpt-6.1-sol`，但未覆盖原生 effort，因此身份核验正确阻止沿用昨晚验证。[无凭据值的身份诊断](evidence-index.md#2026-10-14t01-28-05-265z-default-readback) 保留具体比较结果。没有改摘要或忽略变化来放行，修复环境后需真实重验证。

2026-10-14 09:23，生产仍为 node PID 8840 / cmd PID 8368，心跳无新版本的 `agentExecution` 字段。看门狗 `PipelineDaemonWatchdog` Enabled，间隔 PT2M，自启动配置保持原状；未重启服务，不能将配置读取当成旧 daemon 已加载新默认的证明。

2026-10-13 23:30：47 文件 596 项测试、源码类型、所有新增/修改 TypeScript 脚本的严格类型、前端语法和两仓库 diff 检查通过。Astra 上一次实现 PASS 对应 564 项测试的旧候选，不自动覆盖后续变更；本次环境问题咨询不属于最终统一验收。

2026-10-14 09:35，包含新诊断和显式 sandbox 模式选项的全部新增/修改脚本严格类型检查通过；09:36 最新回退演练也通过，覆盖这些脚本变更及完整关闭快照。旧基线不支持新命名配置的执行，实际回退须排空工单与所有写入者、保留数据及原生会话、暂停新增 OpenCode 入口。源码仍未完成最终 Astra 审计，不把演练候选摘要称为发布摘要。

以下保留此前失败、诊断和恢复过程。其中“当前”“正在”描述对应历史时点，以以上状态为准。

## 请求上限与超时诊断

旧 OpenCode 会话 `ses_ed0e4473cffe7LRpILbf6yCLY3` 的第十二次模型回复耗时约 235 秒，报告 27,667 个输出 token；之后存在原生 compaction。此前运行中观察得出的“未压缩”结论已纠正。不能把未完成的 plan 归因于 CLI 假死。

原生 `limit.output` 是上下文管理声明，不限制 HTTP 请求输出；当前本机模型声明的上下文长度为 262,144。验收提供商配置现在同时保留上下文声明和模型级 `body.max_tokens`。删除了此前没有作用的请求超时配置。

- [OpenCode 请求抓取](evidence-index.md#2026-10-13t06-26-27-409z-opencode-wire)：本地合成接收端抓取两次原生请求，均包含 `max_tokens: 8192`。这是传输诊断，不是模型或工单验收。
- [Claude 请求抓取](evidence-index.md#2026-10-13t06-54-42-468z-opencode-wire)：`CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192` 进入原生请求。接收端故意返回错误，只证明请求配置。
- [真实网关限长调用](evidence-index.md#2026-10-13t07-04-35-761z-provider-cap)：实际模型请求 `max_tokens: 16`，返回 `completion_tokens: 16`、`finish_reason: length`。全部额度用于推理，文本为空；这不代表关闭了模型推理，也不代表完整流程通过。

本机 Claude 的 haiku/sonnet/opus 别名映射到同一个已加载的 `ollama/ornith-1.5:9b` 模型。保留 CLI 原生角色档位，但不宣称实际使用三种不同模型或同等价格分层。Claude 美元数值是 CLI 报告值；本地网关实际美元费用未知。

## 真实工单及恢复

[Claude 新工单](evidence-index.md#2026-10-13t06-28-20-100z-real-ticket) 使用默认阶段模型，完成 clarify、prototype 和 plan。implement 达到 300 秒上限；原始记录包含一个使用 haiku 的任务实现代理派发，违反流水线角色约束，不能计为合格实现。已明确插件对 SDD 的角色覆盖规则，加入反馈，保留失败证据；当前重新验证后显式切换，并在原工单继续独立实现与评审。

[旧 OpenCode 工单重新验证与恢复](evidence-index.md#2026-10-13t06-56-05-535z-real-ticket-resume) 的七入口预检通过，显式切换后 plan 仍在 300 秒终止。完成步骤的最大输出为 7,240 token，23 个完成步骤合计 20,794 token，说明单次上限已生效，但累计阶段耗时仍超限。尚未完成 implement，功能测试失败。后续继续使用同一工单、原始历史和明确的阶段边界切换。

[Claude 续聊预检失败记录](evidence-index.md#2026-10-13t07-07-05-623z-real-ticket-resume) 中 prototype 文本探针耗尽回合，没有激活失败的草稿。续聊探针现禁用工具并明确禁止文件记忆，以专门检查原生对话上下文。[重新验证后的继续执行](evidence-index.md#2026-10-13t07-20-29-890z-real-ticket-resume) 已实际实现功能并通过测试，但派发漏显式模型且缺独立终审，之后 review 返回缺 verdict，仍不合格。

与 Astra 就此具体问题咨询后，加入 Claude implement 原生同步派发门禁（`PreToolUse`，`onFailure:block`，不改写模型输入），成功返回前核验角色标记、明确模型、原生派发/完成关联、独立 child ID 与完整 Task 覆盖。合格证据仅在代码、计划与需求保持一致时可复用；合法 BLOCKED 不强制跑齐角色。原生 hook 至少需要 Claude Code 2.1.295。阶段 schema 明确限定 stage，并要求 review/acceptance 带 nullable verdict（review 另带 axes），完整回程契约仍负责完成态的非空要求。

[Claude 合格恢复及闭环](evidence-index.md#2026-10-13t07-48-34-667z-real-ticket-resume) `ticketFlowStatus: PASS`：真实六阶段、原型、自动测试及四场景独立断言均通过。实现/task-review/final-review 三个原生 child 分别为 `a367a88238dd95dc6` / `a273ff924f85e5e44` / `a2774b8769c35dbff`，显式模型 sonnet/sonnet/opus，实际均为本地9b；没有从实际9b反推别名。保留了前次失败、回退与原始快照历史。

## 默认引擎切换为 Codex

按用户最新指示，内置默认、原生引擎空值解析、新配置表单及生产全局默认均改为 Codex。`gpt-6.1-sol` 是当前本机 Codex 原生配置的明确模型，也作为应用默认写入执行快照；可用命名配置/环境变量覆盖。13 入口回读一致。已有工单继续按原冻结 CLI 执行。

[Codex 全入口首次预检](evidence-index.md#2026-10-13t09-46-59-784z-codex-default) 到 implement 的基础/续聊/只读探测通过；独立子代理返回标记，但 stdout 缺少 spawn 事件，当前严格证据审核拒绝，没有将草稿激活为已验证。正在查明原生 rollout 关联，不能仅靠标记或 wait 放行。

[OpenCode 重新预检失败](evidence-index.md#2026-10-13t09-49-40-379z-real-ticket-resume) 中原生子代理把 `child-secret.txt` 内随机 UUID 误认为凭据而拒绝读取；已改成无害公开测试标记名称和准确说明，仍要求父会话不读取、原生独立子代理真正返回标记。失败草稿未激活，也未切换原工单配置。

## 回退与最终验收

回退演练使用隔离复制的真实已关闭工单，依次加载候选版本、当前 Git HEAD 基线、候选版本，检查完整快照读取和字节级数据保留。不重启生产服务、不运行旧版本去执行新命名配置。旧基线不支持 OpenCode/命名执行计划，实际回退前必须排空工单和全部写入进程，保留数据和原生会话并暂停新增 OpenCode 入口。

[未关闭工单的回退防护](evidence-index.md#2026-10-13t06-52-22-538z-rollback) 正确拒绝开始演练。[真实关闭工单回退演练](evidence-index.md#2026-10-13t09-42-05-483z-rollback) 已 PASS：候选→HEAD基线→候选三次读取均保留完整执行快照；原数据和隔离副本的字节摘要均未改变。其候选摘要早于随后 Codex 默认值改动，最终版本仍需重跑。此证据只覆盖版本加载与关闭快照保留，不代表旧版本能执行新 profile。

目前自动回归在默认切换前为 45 文件 577 测试通过。默认切换后发现两个测试隐含依赖 Claude：迁移单测现显式选 Claude 并避免误调真实 Codex，完整工单集成测试更新为 Codex 模型预期；对应 26 项回归通过。所有工作完成后再由 Astra 统一复验所有改动与原始证据。自动检查、预检、传输诊断均不能替代真实工单、功能断言及最终 Astra 验收。
