# Agent CLI 执行配置

2026-10-14：选择 OpenCode 且未指定模型时，默认冻结内置 `opencode/space-bunny-free`。优先级为命名配置的 `model`、`PIPELINE_OPENCODE_MODEL`、内置免费默认；自定义 provider 必须显式指定模型。CLI 始终收到明确的 `--model`，该模型不可用时停止，不自动退回付费模型。已冻结工单不变，全局默认仍为 Codex。免费模型由上游限时提供，价格和供应以 [OpenCode 官方模型目录](https://opencode.ai/v2/docs/console/models) 为准；此默认值不代表永久免费，也不将缺失的原生成本记录视为已确认零费用。

本机实测：免费模型通过 `run` 入口原有工具权限的 JSON 调用；只读或禁用工具的调用被上游免费服务以 403 拒绝。因此 classify、draft 等只读入口及当前包含无工具续聊／只读 canary 的配置验证不能据此认定通过。保持权限与验证门槛，不自动开放 Shell，也不自动换付费模型。此限制在 [上游问题 #50627](https://github.com/anomalyco/opencode/issues/50627) 有同类报告。完整工单免费模型验收尚未通过；此前本地供应商的验收结果不能代替它。

2026-10-13 按用户要求，默认引擎改为 Codex，默认模型明确冻结为 `gpt-6.1-sol`（可用命名配置或 `PIPELINE_CODEX_MODEL` 覆盖）。Claude Code 与 OpenCode 仍可按项目、入口或工单显式选择。已有工单和续聊保持原快照，不因默认值改变而迁移。控制台的「执行配置」管理命名配置、全局选择、项目选择和入口选择。入口包括六个模型阶段，以及 triage、fast、classify、run、draft、prototype、mr-review。CI 由编排器执行，不经过模型 CLI。

2026-10-12 用户已接受 CLI 原生约束差异：新任务默认 native，旧快照保留原契约，可显式切换。详见 [原生约束模式](native-agent-constraints.md)。Codex/OpenCode 不再因缺少 Claude 等价白名单、模型轮数或金额上限而整体被阻止；真实调用失败或未通过用途验证仍会停止。

配置默认存放在 `data/agent-config.json`，可用 `PIPELINE_AGENT_CONFIG_FILE` 指定其他文件。密钥留在 CLI 的原生认证文件或环境变量中；配置的 `credentialRef` 只保存环境变量名称。

## 选择与冻结

优先级从高到低为：控制台项目入口、项目文件入口、旧 `engine.<stage>`、控制台项目默认、项目文件默认、旧 `engine`、全局入口、全局默认、内置 Codex 默认配置。项目文件为 `docs/pipeline/PIPELINE.md` 的 frontmatter，例如：

```yaml
execution: claude-custom
execution.review: claude-review
```

所引用的配置必须已完成对应入口的能力验证。工作目录为 worktree 时，项目选择使用工单的主仓库路径。

建单冻结所有入口的完整配置，包括模型、工具、轮数、预算和超时。修改默认规则仅影响新工单。原生续聊使用原快照和原会话 ID；续聊失败会明确报告，由用户重新发起 `/run`。

已有工单可以在详情页申请采用当前选择规则，填写原因。正在执行的阶段及其重试继续使用原快照；下一阶段或最终失败后的恢复边界应用切换。独立 mailbox、UUID 与进程锁保护请求，避免阶段保存覆盖它或旧请求删除新请求。历史工单按实际启动事件迁移；无法确定历史 CLI 时须显式选择，不能猜测。

## 验证

新建或修改的配置是草稿。控制台先向服务器取得本次探测计划，展示模型/能力分组、最多调用次数和预算语义，再由用户确认同一计划执行。Claude 每组六次基础调用，Codex 每组四次并先做一次隔离目录初始化；OpenCode native 每组最多六次，包含两次 JSON 调用各自最多一次格式修正。implement 的子代理和浏览器用途增加调用。支持 JSON 契约、文本、原生续聊、拒绝写入；轮数与金额耗尽探测仅适用于 Claude。Codex native 按实际模型、沙箱、子代理与浏览器能力分组，未执行的预算/轮数差异不重复探测。

浏览器 JSON 探测在 OpenCode native 中最多增加两次调用（首次加一次可能的格式修正），其余 CLI 增加一次；implement 的独立子代理探测增加一次。用途预检仅覆盖这些原生能力，不保证项目完整 Bash/SDD 工具链可运行；本机 Codex 完整工单仍受 Windows 沙箱阻挡，详见 [当前闭环记录](acceptance/2026-10-13-release-closure.md)。

Claude `--max-budget-usd` 按已完成模型轮次检查，单轮可能超出参数值，不能作为总费用的严格硬上限。native 显示未执行的原生限制，strict 仍拒绝不等价能力。探测或执行前后检查 CLI 路径、版本、OS 账号、环境及原生认证/配置摘要；摘要不包含可还原凭据。OAuth 凭据轮换也可能保守地要求重新验证。

原配置标为 `legacy`，不冒充已验证配置；自定义配置通过真实探测后才标为 `active`。

Codex 配置使用 TOML 语义摘要；其他目录的纯 trust 登记不使全局认证验证失效，当前目录、祖先和 Git 主仓库的 trust 仍进入项目摘要。未知字段与不确定路径保守保留，TOML 解析失败阻止执行。探测目录在初始化后采集基线，并比较其前后摘要。原始文件摘要仅供诊断，不代替语义校验。

OpenCode native 正常完成但输出外壳不是 JSON 时，可在同一原生会话做一次工具禁用的格式修正，保留两次输出、累计用量、沿用剩余超时。仅卡片摘要超长时也可修正该字段，其他字段必须完全一致。fatal、超时、缺完成事件、缺角色证据及语义契约错误不借此放行；第二次仍严格解析并校验原 schema。工单记录中的 `outputCorrection` 明确标识实际追加调用。

失败调用仍保留原 CLI 已报告的费用，计入工单和每日成本；CLI 超时或异常退出未报告用量时，只显示已报告部分，并明确剩余费用未知。成功返回的阶段结果与失败费用分别记录，避免把失败阶段算作完成。

Claude 的轮数上限限制主循环的工具回合，不是所有子代理的累计轮数。子代理约束仍需独立验证。依据：[Claude agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop#turns-and-budget)、[子代理配置](https://code.claude.com/docs/en/sub-agents)。

工单 CLI 调用在 `data/invocations/` 留下独立进程记录，包含工单号、PID、控制进程、启动时间与工作目录，不保存提示词或参数。恢复时先核验存活调用，未完成的启动记录也会阻止重复启动。PID 可能复用，清理前需核对实际进程启动时间；不按旧 PID 自动终止进程。

## 共用规则

所有入口显式加载 `AGENTS.md` 的通用规则与 `docs/pipeline/PROJECT-KNOWLEDGE.md` 的项目常识。原 `CLAUDE.md` 保留为兼容输入，冲突时报告并停止。沉淀建议分别写入 `agentsMd`、`projectKnowledge`；旧 `claudeMd` 字段兼容映射到项目常识。插件路径变量为 `${PIPELINE_PLUGIN_ROOT}`，桥接仍理解旧变量。

缺少共用 skill、原生子代理或必需工具时必须报告 BLOCKED，不得让单一会话模拟子代理或改用其他 CLI。

## 历史验收限制（接受原生模式之前）

Claude、Codex、OpenCode 均已接入统一适配器注册表和配置选择。Codex 当前缺少已验证的等价白名单、轮数与金额预算；OpenCode 2.0.6 的权限动作、每代理步数、金额预算和角色子代理尚不能满足全部共用约束。这两个适配器目前明确阻止生产模型调用，不能据此宣称三个 CLI 均已可用。

2026-10-12 已执行真实三 CLI 调用并复测。Claude 的 JSON、续聊、只读、轮数/预算停机、独立子代理与 Playwright 探测通过；Codex 的结构化输出、共用规则读取和续聊通过；OpenCode 使用私有本地提供商配置后，严格 JSON、共用规则和续聊通过。详细证据见 [真实三引擎验收](acceptance/2026-10-12-real-engines.md)，v2 配置与限制见 [OpenCode 分析](opencode-v2-analysis.md)。完整隔离工单、完整子代理角色模型及 Codex/OpenCode 的必需约束仍未完成验收，不能据基础调用就宣布整体通过。

随后真实验证了三档显式 Agent 派发并核对独立子会话，修复后的 implement 入口预检通过。三档实际仍映射到同一本地模型，主循环上限没有覆盖子代理总回合。OpenCode 实测复现 Write/Edit 合并和子代理失败；完整 runTicket 三次在澄清阶段超时，最后时限 300 秒，实际功能样例未通过。已修复无用量超时被记为零费用、独立子代理证据不足的问题。见 [剩余验证报告](acceptance/2026-10-12-remaining-validation.md)。整体仍未通过，未启用失败配置或重启生产服务。

## 本机运行记录

用户此前确认编排器与看门狗已启动，看门狗已配置自启动。2026-10-11 22:33（UTC+8）只读复查：`PipelineDaemonWatchdog` 任务已启用，重复间隔 `PT2M`，`data/watchdog.last-run` 记录为 session 0 的最新巡检；`data/daemon.pid` 指向存在的 PID 8368（cmd），其子进程为 node PID 8840。当前权限未返回该 node 的命令行，无法仅凭此独立确认应用健康。实现期间未重启服务或修改生产执行配置。

2026-10-13 后续按用户要求保存了全局 Codex 默认（revision 3）及 PIPELINE_CODEX_HOME，独立进程按看门狗的 `.env` 读取方式核验全部 13 入口与原生身份通过。2026-10-14 原生配置由外部变更，旧验证现被身份核验阻止，须真实重验证；09:23 生产仍为原 PID，心跳不含新版本执行配置字段。未重启服务，不能宣称旧 daemon 已启用新默认；看门狗仍已启用。
