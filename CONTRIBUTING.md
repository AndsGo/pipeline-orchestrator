# 参与开发

欢迎 issue 与 PR。这份文档说清开发环境怎么搭、代码按什么纪律写、改哪类东西要动哪些地方。

## 开发环境

```bash
git clone https://github.com/AndsGo/pipeline-orchestrator.git
git clone https://github.com/AndsGo/pipeline-plugin.git    # 平级目录；或设 PIPELINE_PLUGIN_DIR
cd pipeline-orchestrator
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest，35 个文件，不触网、不起真会话
```

测试全部离线：假引擎（`stageRunner` 注入）+ 脚本化端口（`InteractionPort` 实现）+ 临时 git 仓库 + `PIPELINE_DATA_DIR` 指向临时目录。**不需要飞书、模型 API 或任何凭据就能跑全量测试**。

改完代码想真机验证：`npx tsx scripts/doctor.ts` 体检，`npm run orchestrate -- <repo> <ticket> --auto` 用自动放行端口跑一张工单（会花模型费用）。

## 提交前

- `npm run typecheck && npm test` 全绿。
- 改了 `src/` 就要有对应测试；改了主循环行为要在 `src/__tests__/ticketRunner.integration.test.ts` 加或改场景。
- 不要 `git add -A`——`data/`、`logs/`、`.env` 虽在 `.gitignore`，但习惯上按路径 add。
- **绝不提交凭据**。`.env` 永不入库；日志与文档里不出现 token 值（只写键名、有无、长度）。

## 代码纪律

这些不是风格偏好，每条背后都有一次真实事故。改代码时请沿用：

1. **状态机保持纯函数。** `src/machine.ts` 的 `route()` 不做 IO、不发消息、不读文件。新的路由分支加在这里，执行放到 `src/run/actions.ts`。
2. **决策规则写进代码，不写进流程图。** 例：评审打回上限 `FIX_ROUND_CAP` 是状态机里一个返回 `halt` 的分支，不是文档里一句话。
3. **注释引用事故。** 一条规则为什么存在，注释里写它防的是哪张工单、哪天、什么现象（现有代码里满是 `（LS-012 实测，2026-08-24）` 这类注释）。没有事故的规则通常不该加。
4. **对自己诚实。** 成本算不出就记 0 并注明"未计价"；能力地图落后多少提交写在注入头里；验收没法实测就记"无法验证"。不猜、不冒充。
5. **面向人的文案原样保留。** 群里的每一句提示、每张卡的措辞，都有人在依赖。重构时逐字面量核对（上次拆分 daemon 时用脚本比对了 372 个字面量）。
6. **可观测性工具不得影响被观测对象。** 别用 `tail -F` 攥着 `data/` 下的文件——曾让每日备份连续三天全部失败。
7. **轮数与预算一起调。** `src/config.ts` 里每阶段的 `maxTurns` 与 `budgetUsd` 只抬一个，约束就从这头搬到那头，会话照样半途死掉且死因更难查。

## 提交信息

沿用现有风格（中文，conventional 前缀，标题说清**为什么**，正文引用实测）：

```
fix(release): 上线后补验卡异步挂着不阻塞 compound；停止信号的「空闲」改为无会话在执行

OP-002 实测：补验卡要等运营做完模块升级才能答，可能是几天，此前 runner 在它上面 await，
知识沉淀跟着挂、工单一直「在跑」、daemon.stop 也永远等不到空闲。……
```

前缀：`feat` / `fix` / `refactor` / `docs` / `test` / `chore`，括号里是模块（`daemon` / `runner` / `engine` / `feishu` / `profile` / `release` …）。

## 改哪类东西要动哪些地方

| 要做的 | 动这些 | 别忘了 |
|---|---|---|
| **加一条群内指令** | `src/commands.ts`（`Command` 联合类型 + `parseSlash` + `helpText` + `SLASH_COMMANDS`）→ `src/daemon/handlers/<name>.ts` → 注册进 `handlers/index.ts` | 注册表按 `Command['kind']` 穷举，漏配编不过。加单测到 `daemonHandlers.test.ts` |
| **加一个执行引擎** | `src/engine/<name>.ts` 实现 `Engine`（`runStage` / `runText`），注册进 `engine/index.ts` | 必须吐出同形状的 Envelope 六字段；成本算不出就 `priced:false`；见 `codex.ts` 里四道坎的处理 |
| **加一个交互端口** | 实现 `src/ports.ts` 的 `InteractionPort`（四个方法） | 参考 `CliPort` / `AutoPort`；`askQuestions` 要支持"人不答"的挂起语义 |
| **加一个阶段** | `src/types.ts` 的 `Stage`、`src/commands.ts` 的 `STAGES`、`src/config.ts` 的 `STAGES` 配置、`src/machine.ts` 的 `NEXT` 与 `route`、pipeline-plugin 里新 skill | 这条最重；如果只是"某阶段之前/之后做件事"，优先像上线环节那样做成编排器原生步骤而不是新阶段 |
| **加一个 `PIPELINE.md` 开关** | `src/profile.ts`（`PipelineProfile` + `parseProfile` + `stageBrief` + `profileTemplate`） | 开关要在 `stageBrief` 里解读成人话写进阶段节选 |
| **改契约字段** | 在 pipeline-plugin 改 `schemas/stage-result.schema.json` + `handoff-spec.md` 版本号；本仓库 `src/types.ts` 的 `StageResult` 跟随 | 两个仓库同时出 PR；契约版本升主/次位 |
| **加一个运维脚本** | `scripts/<name>.ts`，头三行注释写用法 | 自己装载 `.env`（参考 `doctor.ts`），不回显任何密钥值 |

## 目录里的"活文档"

- `src/config.ts` 每阶段的模型/轮数/预算旁边有调参史，改数字前先读注释。
- `docs/design/` 放设计稿；实现后在稿子顶部标"已实现 + commit"。
- `ONBOARDING.md` 是给终端用户的，改了用户可见行为要同步。

## 报告问题

开 issue 时请带：daemon 日志相关片段（`logs/daemon.log`，脱敏）、对应工单的事件流（`data/<ticket>.events.jsonl`）、`npx tsx scripts/doctor.ts --no-infer` 的输出。安全问题走 [SECURITY.md](SECURITY.md)。
