# CLI 原生约束模式

2026-10-12 用户明确接受各 CLI 的原生约束差异并允许执行。新任务默认冻结 `constraintMode: native`；2026-10-13 按用户后续要求将默认引擎改为 Codex。严格兼容仍可在命名配置选择 `constraintMode: strict`。配置已保存，旧生产 daemon 尚未加载新代码；实际状态见 [闭环记录](acceptance/2026-10-13-release-closure.md)。

旧工单/续聊快照没有该字段时按 strict 处理，历史无快照工单迁移也保留 strict。通过既有显式切换流程在阶段边界采用新模式，运行中阶段及其重试不变。

## 原生行为

| CLI | 权限 | 轮数/步骤 | 金额 | 子代理 |
|---|---|---|---|---|
| Claude | 工具白名单、dontAsk、显式 MCP | 主循环工具回合，不含子代理累计回合 | 按响应完成后检查，可越额 | 原生 Agent/Task，Claude 模型别名 |
| Codex | read-only / workspace-write 沙箱，非逐工具白名单 | 无原生模型轮数上限 | 无原生金额上限 | 原生子代理及模型配置，必须真实验证 |
| OpenCode | 原生权限动作，Write/Edit/patch 共享 edit | 每代理每条消息 steps，末步移除工具 | 无原生金额上限 | 原生 subagent，独立权限/步骤及原生模型配置 |

Codex/OpenCode 的 `budgetUsd` 只保留为用户设置值，不伪装成停机限制；Codex 的 `maxTurns` 不执行轮数停机。三者仍执行编排器超时、进程回收、JSON 契约及原会话身份检查。`executionConstraints` 写入阶段启动事件，记录实际约束及未执行的参数。

通用 `effort` 对 Claude 使用 --effort；Codex 使用 model_reasoning_effort（max 映射 xhigh）；OpenCode 用明确 model#variant 选择原生档位，通用 effort 字段不执行。

## 配置与验证

```json
{
  "id": "codex-development",
  "name": "Codex 开发",
  "cli": "codex",
  "constraintMode": "native",
  "model": "gpt-6.1-sol",
  "state": "draft",
  "parameters": { "effort": "low", "timeoutMs": 300000 }
}
```

配置仍需按用途验证后启用；native 不自动启用失败的草稿。Claude 每组六个基础调用；Codex 每组四个并先做一次隔离目录初始化；OpenCode native 每组最多六个，含 JSON 探测各自最多一次原会话格式修正。implement 额外一个独立子代理调用；浏览器用途增加实际 Playwright JSON 导航探测（OpenCode native 连同可能的格式修正最多两个）。原生差异不再要求 CLI 产生不存在的金额/轮数停机信号。

浏览器能力可单独选择，选择值绑定到探测计划 token。未验证浏览器时，普通评审/验收可启用，但 e2e: playwright 快照仍在调用前被阻止。验证目录是实际临时 Git 仓库，避免子代理使用未受跟踪目录的全局项目上下文。

只覆盖部分入口的配置只能按入口绑定，不能作为所有 13 个入口的全局/项目默认；控制台会禁用该默认选择。要使用默认配置须先验证所有用途。

CLI 不能提供必需独立子代理结果时，该用途验证失败。允许 native 差异不等于允许单个会话模拟实现/评审/终审。共用 pipeline-implement 规则对非 Claude CLI 使用原生角色/模型并记录实际配置，不传入 Claude 专用别名。

没有可靠美元价格时，费用显示未知，不能显示免费调用。已报告部分与完整总额分开；事件、工单记录、列表/详情、每日总览与闭环通知保留未知/部分状态。

## Windows 与原生上下文

Astra 整体审计后补充：Codex/OpenCode 不支持通用 credentialRef，必须留空并使用原生认证，不能宣称该字段选择了实际账号。OpenCode provider.env 继续由原生配置管理，其任意环境变量引用值纳入指纹；Codex env_key 同样纳入。外部配置文件内容及祖先项目原生配置在实际执行 cwd 冻结和核验，逻辑主仓库仅用于配置选择。active 旧快照缺该指纹须重新验证后显式切换，不能静默补齐。详见 [Astra 问题与修复记录](acceptance/2026-10-12-astra-overall.md)。

配置写入与切换仍使用排他锁；根据 Astra 复现的竞态，当前禁止自动回收旧锁。若进程崩溃留下锁，必须停止全部写入进程后显式清理，不能在服务运行中删除锁。本轮没有重启或停掉生产服务。

Codex 独立子进程移除宿主 CODEX_THREAD_ID / CODEX_SESSION_ID，保留其原生配置与认证。PIPELINE_CODEX_HOME 可显式绑定服务使用的原生 home；实际启动环境与身份核验共享同一解析逻辑。指纹核验实际 CODEX_HOME 的 config.toml / auth.json，宿主会话元数据不当作凭据，原生 provider 显式引用的变量仍绑定。TOML 语义摘要保留实际 cwd、祖先与 Git 主仓库的 trust，其他目录的纯 trust 登记不使全局身份失效。不打印或保存密钥。

Codex 配置支持显式 `parameters.windowsSandbox: elevated | unelevated | mxc`，参数随工单冻结，不自动修改模式。MXC 预检要求 CLI 至少 0.162.0；启动 canary 成功仍不证明 Bash/SDD 可运行。本机 unelevated 基础探针通过但真实 plan 中 Bash 失败；MXC 有 MSYS 初始化拒绝；elevated 被占用的 node_repl.exe 阻挡。见 [当前闭环状态](acceptance/2026-10-13-release-closure.md)。没有据此关闭沙箱或宣称完整工单通过。模式边界依据：[官方 Windows 沙箱文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)。

OpenCode 保留 OPENCODE_CONFIG_CONTENT 中的原生提供商定义，合并编排器固定的代理权限、skills 与 MCP。在 native 模式，已恢复的工具错误保留在原始事件里，不把它们一律当成整场失败；必须最终正常完成并通过结构校验。fatal 错误、空正文、混合 session ID、未完成历史仍失败。旧 strict 模式保留原有保守处理。

## 已有真实证据

[Codex/OpenCode run 用途](acceptance/evidence-index.md#2026-10-12t06-01-23-582z-native-engines)完成 JSON、文本、原生续聊和只读验证，并实际在独立配置文件里启用为 active；生产配置未改。该结果不代表 implement 或完整工单通过。

[原生 Codex 完整工单尝试](acceptance/evidence-index.md#2026-10-12t06-06-30-810z-real-ticket)实际进入 clarify，Windows 执行辅助程序失败后返回 BLOCKED，功能样例失败；没有以差异许可绕过真实执行失败。其余证据见 [真实验收](acceptance/2026-10-12-real-engines.md)。Astra 尚未最终验收。

[OpenCode implement 用途](acceptance/evidence-index.md#2026-10-12t06-32-06-702z-native-engines)真实验证并隔离启用通过，包含独立子代理读取和禁止主会话读取隐藏标记的证据。其后六阶段及原型的无浏览器预检也通过，完整工单已实际发起：[完整工单当前证据](acceptance/evidence-index.md#2026-10-12t07-05-53-187z-real-ticket)。不能以预检通过代替工单最终验收。

同一工单真实完成 clarify、prototype，plan 生成工件后因最终非 JSON 回复停止；[首次恢复](acceptance/evidence-index.md#2026-10-12t07-21-13-951z-real-ticket-resume)在 plan 达到 300 秒超时。记录显示多次原生压缩后重复读文件，隔离验收显式调整压缩参数，保留原生自动压缩和 32k 模型声明。身份核验拦截上下文变化，没有修改旧快照绕过核验。

[重新验证及显式边界切换](acceptance/evidence-index.md#2026-10-12t07-53-51-420z-real-ticket-resume)预检通过后，以正式切换事件保留新旧快照，继续 plan；CLI、模型、权限、回合和超时未改。代理 system 固定实际 JSON Schema，防止原始消息在压缩后失去输出约束，且明确 schema 不是应返回的任务结果。失败的早期重验证证据保留，未启用失败配置。开发自检最新 550 项测试、类型与脚本类型检查通过。

2026-10-12 16:00（UTC+8）的阶段观察：当时看到 11 条完成的 assistant 工具消息，尚未再次压缩；后续确认存在原生 compaction，不能将这段观察扩展为整个会话“没有压缩”。该次 plan 在 300 秒超时，四场景功能断言失败，`ticketFlowStatus: NOT_PASS`。后续 OpenCode 完整工单与原生角色证据已通过；Codex 环境和 Astra 最终验收仍待完成，见 [闭环记录](acceptance/2026-10-13-release-closure.md)。
