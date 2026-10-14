# OpenCode v2 接入分析

核查日期：2026-10-12。本机版本：2.0.6。结论：可使用现有本地网关完成真实调用；原生配置、代理和协议应按 v2 接入。用户已接受金额、步骤、权限等原生差异，实施说明见 [原生模式](native-agent-constraints.md)。独立子代理能力已真实通过，完整角色流程尚未验收。下文早期严格等价限制保留为历史分析。

## 长会话与结构化输出

真实计划阶段出现反复压缩、重复读文件及最终非 JSON 输出。上游 v2.0.6 源码 `packages/core/src/session/compaction.ts` 默认 buffer 为 20000、保留尾部 15000；32k 模型只剩 12768 的触发阈值。在线文档当前写的是 10% 默认值，与该已安装版本不同，不能直接套用。隔离验收配置显式设置 `compaction: { auto: true, buffer: 3277, keep: { tokens: 8192 } }`，继续启用压缩且保留模型真实声明的 32k 上限，不改全局配置。依据：[原生压缩设置](https://opencode.ai/v2/docs/compaction/)。

代理的 system 指令固定本次 JSON Schema，避免原始用户消息在压缩后不再携带输出契约。native 兼容单个完整 JSON 代码块；带说明文字、损坏 JSON 仍失败，保留真实 session、回合与已报告费用。提供商上下文改变触发身份核验，必须重新真实验证并显式边界切换，不能修改旧快照绕过核验。

## 执行入口

采用 `opencode run --standalone --format json --agent <固定代理> --model <provider/model>`，续聊显式传原 `--session`。`--format json` 输出事件流，不能据此宣称最终回复符合 JSON Schema。私有 server 避免继承共享服务进程的旧环境；本机 `run --help` 另确认 stdin 与会话参数的实际行为。[CLI](https://opencode.ai/v2/docs/cli/)、[命令](https://opencode.ai/v2/docs/cli/commands/)

## 提供商

v2 使用 `providers`、`package`、`settings.baseURL`、`models.<别名>.modelID`。网关采用 `@opencode/ai/providers/openai-compatible`，凭据通过该提供商的 `env` 引用传入。模型选择包含提供商前缀；别名与实际发送的模型 ID 是不同字段。`auth list` 空不能否定通过环境变量连接的自定义提供商。[Providers](https://opencode.ai/v2/docs/providers/)

以下是待填入真实模型信息的配置形状，不自动写入用户配置：

```json
{
  "providers": {
    "pipeline-gateway": {
      "env": ["PIPELINE_GATEWAY_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8888/v1" },
      "models": {
        "coding": { "modelID": "ollama/ornith-1.5:9b" }
      }
    }
  },
  "model": "pipeline-gateway/coding"
}
```

模型的工具能力、上下文和输出长度要按实际模型设置，不能将目录默认值当作实测结果。变体用 `#variant`，自定义模型 ID 可以包含斜杠；编排器现在会正确补齐所选 provider 前缀。[Models](https://opencode.ai/v2/docs/models/)

## 权限与代理

v2 使用有序 `permissions`，最后匹配的规则生效；默认无匹配为 ask。自动化先 deny 全部，再按入口放行 read/glob/grep、edit、shell、skill 或明确 MCP action。`edit` 同时覆盖写入、修改和 patch，无法直接逐字替代 Claude 的 Write/Edit 分离。[Permissions](https://opencode.ai/v2/docs/permissions/)

代理放在 `agents`。父代理的 subagent 规则限制可启动哪些子代理；子代理使用自己的权限。子代理可以独立指定模型，未指定则继承父会话模型。实现、规范评审、质量评审应配置成独立角色，逐个检验，不能仅有一个通用 worker 就声称满足全部 SDD 纪律。[Agents](https://opencode.ai/v2/docs/agents/)

`steps` 限制该代理的模型步数，最后一步移除工具，下一条用户输入重置。它不是父子会话累计轮数。文档中的 provider `cost` 是计价信息，`limit` 是 token 限制；本次未发现可证明等价于金额硬上限的原生选项。这是核查结论，不代表外部插件永远无法实现。[Agents](https://opencode.ai/v2/docs/agents/)、[Models](https://opencode.ai/v2/docs/models/)

策略位于 `experimental.policies`，可收紧 provider 与 permission；组织和全局策略可能覆盖项目规则。不能通过项目配置假定所有全局限制已失效。[Policies](https://opencode.ai/v2/docs/policies/)

## 共用规则、skill 和 MCP

v2 原生加载 AGENTS.md，不回退读取 CLAUDE.md；`instructions` 字段目前虽被接受，内容并不会按该字段加载。PROJECT-KNOWLEDGE.md 与旧 CLAUDE.md 兼容输入仍由编排器显式交付。[Instructions](https://opencode.ai/v2/docs/instructions/)、[Config](https://opencode.ai/v2/docs/config/)

可通过 `skills` 数组注册插件的绝对 skill 目录。SKILL.md 可复用，`disable-model-invocation` 会隐藏自动发现，但仍可显式加载。路径决定 ID，name 是显示名；所需外部 skill 缺失须阻止执行。[Skills](https://opencode.ai/v2/docs/skills/)

MCP 放在 `mcp.servers`，禁用字段为 `disabled`。空 servers 不会抹去所有继承连接。浏览器用途应检查实际合并配置，关闭无关服务器并只授权 Playwright action；当前不能仅凭手写配置宣布隔离已通过。[MCP](https://opencode.ai/v2/docs/mcp-servers/)

## 版本核验与本次修复

官方文档链接的 `opencode.ai/config.json` 在本次返回中仍展示 provider/agent/permission 等兼容字段，和 v2 页面示例存在差异。不能仅用该在线 Schema 否定 v2 字段；应结合固定版本源码及私有 server 的有效配置核验。[迁移](https://opencode.ai/v2/docs/migrate-v1/)、[在线 Schema](https://opencode.ai/config.json)

本机 2.0.6 的 CLI reconcile 路径可能返回最终 text 后退出，却未输出 step_finish。适配器现在只在 exit 0 且缺完成事件时读取同一会话：要求同一 message ID、正文完全一致、completed 时间、正常 finish 和 succeeded idle。旧消息、未完成、失败或串会话不能补成成功。会话导出仅在内存使用，不记录完整历史。[2.0.6 CLI 源码](https://github.com/anomalyco/opencode/blob/v2.0.6/packages/cli/src/run/noninteractive.ts)

额外设置 primary agent 的输出纪律，保留 AJV 最终契约检查；模型违反 JSON 契约时仍报错，不剥取一段似是而非的 JSON 来放行。

## 实测状态

- [纯文本与原会话续聊通过](acceptance/2026-10-12T03-08-13-091Z-opencode-local/results.json)
- [共用规则、项目常识、JSON 与续聊通过](acceptance/2026-10-12T03-15-30-784Z-opencode-local/results.json)
- 本次使用现有本地网关凭据的环境变量引用和已加载模型；提供商配置只注入私有诊断进程，未写入生产配置或登录文件。
- 尚未完成金额约束、角色子代理、浏览器及完整 OpenCode 工单验收。生产 wrapper 继续拒绝不满足必需能力的配置。
