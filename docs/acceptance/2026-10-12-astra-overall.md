# Astra 整体验收：尚未通过

本页保留 2026-10-12 的审计轮次。2026-10-14 最新进展见 [闭环记录](2026-10-13-release-closure.md)：Claude/OpenCode 工单已通过，Codex 环境仍阻塞；下述实现 PASS 不自动覆盖后续代码改动。按用户要求，剩余任务完成后再进行最终统一验收。

最新结论（第四轮）：**实现审查 PASS；整体真实验收 NOT PASS**。Astra 确认已报告的代码阻塞均已关闭，未发现新的阻塞实现缺陷；独立复跑 43 个测试文件、564 项测试、typecheck 和前端语法全部通过。本轮无额度阻塞。

完整真实工单仍停在 plan 的 300 秒超时，功能断言失败，尚未完成实现、完整独立评审及收尾。不能把实现审查 PASS 标为整体任务完成。

范围：`pipeline-orchestrator` 与相邻 `pipeline-plugin` 的 `feat/opencode-agent-config` 全部改动，包括新增文件；按用户已接受的 CLI 原生约束差异验收，历史 strict 快照保留原意。

## 首轮审计

Astra 实际启动了审计，并在消息中明确给出 NOT PASS。返回以下五组问题及一个恢复问题，随后审计进程再次因工作区额度耗尽退出。此结论不是完整最终报告，也不是尚未开始审计。

| Astra 发现的问题 | 本轮修复与回归 |
|---|---|
| Codex 空输出、缺会话、缺完成事件仍可成功；伪造 session | 严格事件解析，唯一真实 thread ID，正文后正常完成事件，文件/事件正文一致性，整串 JSON 解析；不造 session 或把费用说明作为正文 |
| credentialRef 没有绑定实际 Codex/OpenCode 凭据 | 首次 OpenCode inline 限制仍不足以覆盖认证合并；第二轮后 Codex/OpenCode 均明确拒绝通用 credentialRef，使用 CLI 原生认证。OpenCode provider.env 仍可在原生配置中使用，实际引用值纳入摘要 |
| 身份指纹漏 OPENCODE_CONFIG 文件及项目原生配置 | 哈希外部配置内容、CONFIG_DIR、CLI 对应祖先项目配置；新增 frozen nativeContext，所有命名执行调用核对实际 cwd 的配置指纹，旧 active 快照缺指纹需显式重新验证和切换 |
| Codex 子代理可由父读取或无关 spawn 伪装 | 匹配唯一 completed spawn、真实父/子 ID、后续该子 wait 的 completed 状态与隐藏标记；拒绝探针父会话的执行/MCP/文件/搜索工具 |
| /run、triage、fast、prototype 丢费用状态和实际 session | 原始记录、事件、卡片、快照、运行面板、分诊/快车道、原型及成本合计保留状态；未知费用不显示免费，原型不造 session；失败调用保留已报告用量 |
| wx 锁崩溃后永久堵塞 | 首次自动回收被 Astra 复现竞态，已按建议删除所有自动回收；保留 wx 互斥与 PID/token。崩溃恢复须停止全部写入进程后显式清理锁，暂不支持自动恢复 |

回归：`src/__tests__/agentAudit.test.ts`、Codex 事件测试及完整工单集成测试。2026-10-12 21:58（UTC+8）：43 个测试文件、559 项测试通过，TypeScript typecheck 通过。自动测试不能替代 Astra 复验。

## 复验与真实执行

第二轮 Astra 返回正式 NOT PASS（本轮没有额度阻塞），复跑 559 项测试和类型检查通过。确认首批 Codex 协议、独立子代理和费用/session 修复，同时发现：worktree 与逻辑仓库混用；OpenCode 认证覆盖不完整；原生自定义凭据变量没冻结；自动回收锁存在 TOCTOU；探测前后 CLI 参数不一致。

再次集中修复：绑定选择仍依据逻辑仓库，原生指纹改在实际执行 cwd 冻结，新建/迁移/切换均使用工单 repo；Codex/OpenCode 均拒绝通用 credentialRef；从配置来源提取 provider.env、{env:NAME}、Codex env_key，并哈希实际引用的变量值；删除自动锁回收；探测前后使用相同 CLI 参数。新增对应回归后 43 文件、561 项测试及 typecheck、前端语法通过（22:09 UTC+8）。

第三轮仍为 NOT PASS，另发现 OpenCode `{file:...}` 来源未冻结、分类重试重新选 CLI、OpenCode 失败丢弃已报告用量。已按原生替换顺序处理文件引用（配置源目录、inline cwd、~/、环境展开），不记录密钥值；分类重试复用同一执行快照；OpenCode 失败抛出携带用量的 CliExecutionError，费用不完整时为 partial。新增对应回归后 564 项测试和类型检查通过。

第四轮 Astra 对最后三项逐项复验，并结合前几轮全树审查，给出实现审查 PASS、整体真实验收 NOT PASS。确认保守锁恢复方案可以接受：异常遗留锁须停止写入后人工清理；没有自动回收能力。

没有新增真实模型调用、修改生产配置或重启服务。此前“额度阻塞”仅描述首轮中途退出及历史情况，不能代替第二轮的真实 NOT PASS 审计结论。

最新真实完整工单仍停在 plan 的 300 秒超时，功能断言失败。六阶段能力预检通过不代表完整工单通过，历史证据详见 [三引擎真实验收](2026-10-12-real-engines.md)。本轮协议/身份/证据修复后，历史能力证据也不能自动视为最新版真实验收。
