# 从零跑通第一张工单

目标：一小时内在你的环境里让一张真实工单走完澄清 → 计划 → 实现 → 评审 → 验收 → 沉淀。CI 与上线环节先不配（可选，见最后一节）。

## 0. 你需要准备的

| 项 | 说明 |
|---|---|
| 执行机 | Windows / Linux / macOS 均可。启动、看门狗等脚本有 PowerShell 与 bash 两版 |
| Node ≥ 20 | `node -v` |
| `claude` CLI | 已登录、在 PATH。这是默认执行引擎 |
| 飞书自建应用 | 有机器人能力；步骤见第 1 节 |
| 一个目标代码仓库 | 本地 clone，git 干净；有 `origin`（用于推分支与建 MR，没有 GitLab 也能跑，只是不建 MR） |
| 两个仓库平级 clone | `pipeline-orchestrator/` 与 `pipeline-plugin/` 在同一父目录，或设 `PIPELINE_PLUGIN_DIR` |

## 1. 建飞书应用（一次性，约 10 分钟）

1. [飞书开放平台](https://open.feishu.cn) → 创建**企业自建应用** → 添加**机器人**能力。
2. **权限管理**，开通：
   - `im:message` — 发消息、发卡片
   - `im:message.group_at_msg` — 接收群里 @ 机器人的消息
   - `im:message.group_msg` — 读群消息（引用回复、话题里的消息、置顶文件需要）
   - 如果要用多维表格看板与云文档归档，另加 `bitable:app`、`base:app:create`、`docx:document`、`wiki:wiki`（可后补）
3. **事件与回调** → 订阅方式选 **使用长连接接收事件**（免公网回调地址）→ 添加事件 `im.message.receive_v1`，添加回调 `card.action.trigger`。
4. **版本管理与发布** → 创建版本 → 发布（企业自建应用通常管理员秒批）。
5. 建一个飞书群，把机器人拉进去。
6. 取三个值：应用凭证页的 **App ID / App Secret**；群的 **chat_id**（`oc_` 开头）——启动 daemon 后跑 `node scripts/list-chats.mjs` 能列出机器人所在的群。

> 长连接的限制：**一个应用只能有一条有效长连接**，多实例会互相抢回调。daemon 单实例部署，启动脚本自带检查。

## 2. 安装与配置

```bash
git clone https://github.com/AndsGo/pipeline-orchestrator.git
git clone https://github.com/AndsGo/pipeline-plugin.git
cd pipeline-orchestrator
npm install
cp .env.example .env
```

编辑 `.env`，最少填这四行（保持 UTF-8）：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_CHAT_ID=oc_xxx
PIPELINE_PROJECTS={"myapp":{"repo":"D:/work/myapp","prefix":"MA"}}
```

`PIPELINE_PROJECTS` 是一行 JSON：别名 → `{ repo 本地路径, prefix 工单号前缀 }`。工单号会是 `MA-001`、`MA-002`……。其他字段（`gitlab`、`jenkins`、`wikiArchive`）以后再补，见 [configuration.md](configuration.md)。

体检：

```bash
npx tsx scripts/doctor.ts --no-infer
```

它会逐项报 ✅ / ⚠️ / ❌：node 版本、`claude` CLI、插件目录、飞书 token 能不能取到、每个项目的仓库路径与 `.gitignore` 是否屏蔽了 `docs/pipeline`、有没有 `CLAUDE.md` 和 `PIPELINE.md`。**❌ 全清再往下走**；⚠️ 是建议，先跑通再说。

## 3. 给目标仓库放一份流程约定

在目标仓库里建 `docs/pipeline/PIPELINE.md`（体检会提示缺失；也可以用群内 `/addproject` 接入时自动生成模板）。第一张工单用最保守的配置：

```yaml
---
testEnv: none            # 先不配测试环境：人工验收项会记「无法验证」留到上线后补验
acceptor: dev            # 研发自验
release: none            # 先不设上线环节
---
# myapp 流水线项目约定

## 全阶段
（写这个仓库的硬约束：怎么跑测试、哪些目录不许碰、术语口径）

## implement
（测试命令模板、已知的坑）

## acceptance
（验收样例数据在哪、人工项怎么写）
```

正文按阶段分节，每个阶段开工前会话会先读自己那一节。**这是把"你的仓库不能全新安装""这个项目没有测试环境"这类只有你知道的事实告诉智能体的地方**——写得越实，后面越省钱。

顺手确认目标仓库的 `.gitignore` 没有屏蔽 `docs/` 或 `CLAUDE.md`（体检会查）。屏蔽了的话流水线工件与沉淀的常识都进不了 git。

## 4. 启动

```bash
scripts/start-daemon.sh        # Linux / macOS
.\scripts\start-daemon.ps1     # Windows
```

两版做的事相同：单实例检查 → 装载 `.env` → 日志轮转 → 后台启动 → 5 秒后核实进程还在。直接 `npm run daemon` 也行，只是少了这些护栏。

日志在 `logs/daemon.log`。看到这两行就绪：

```
[daemon] … daemon 就绪：并发上限 2，项目 myapp（工单号前缀 MA-）（默认 myapp）
[info]: [ '[ws]', 'ws client ready' ]
```

群里会收到一条"编排器已上线"加指令帮助。

## 5. 第一张工单

在群里 @机器人：

```
/new 给用户列表页加一个按创建时间排序的开关
```

接下来会发生的事（一张中等需求约 30–60 分钟，$15–40）：

1. **分诊**（$0.02）：判定走快车道还是全流水线。
2. **澄清**：会话先读代码再提问。如果需求有歧义，会弹一张**问题卡**——每题带推荐答案与理由，点按钮或打字回答（`Q1 不通过 实际是…`；`全部通过` 一次答完）。答完自动重跑澄清定稿。
3. **结果预览 + PRD 确认卡**：卡上带一个预览页链接（界面原型 / 数据样例 / 流程图），页底附验收标准清单。看完点通过或驳回。
4. **计划审批卡**：任务拆分 + 决策摘要。通过后进实现。
5. **实现**：TDD、子代理分层、写进度台账、建 MR。大计划会自动分批。
6. **独立评审**：新会话、看不到实现过程、自己跑测试。BLOCK 会自动回实现修（上限 2 轮）。
7. **验收**：自动项亲自跑并记证据；人工项弹卡（`testEnv: none` 时自动记"无法验证"）。
8. **沉淀**：交付文档、知识条目、术语、CLAUDE.md 建议——各弹一张人审卡，采纳后生效。

随时可以 `/status MA-001` 看时间线，`/list` 看全部工单，`/dashboard` 看面板。

**中途想改需求**：`/amend MA-001 排序要支持升降序切换` —— 会回退到澄清重跑（有确认卡）。

**机器人重启了**：启动时会自动点名被打断的工单和失效的卡片，照提示说「继续 MA-001」即可，进度不丢；审批卡会原样重发，不重跑阶段。

## 6. 工单跑完你会得到什么

目标仓库 `docs/pipeline/MA-001/` 下：

```
00-intake.md          需求原文
10-prd.md             PRD + 验收标准（每条带 Given/When/Then、业务描述、验证命令）
20-plan.md            任务分解 + 全局约束
ledger.md             实现进度台账
25-impl-report.md     实现报告
30-review-r1.md       评审报告（双轴：Spec / Quality）
40-acceptance.md      验收结果总表
90-retro.md           复盘
95-delivery.md        交付文档
96-knowledge.json     知识条目
93-terms.json         术语提议
```

全部随 feature 分支提交进 git，与代码同一个 MR。

编排器侧 `data/MA-001.json`（状态）与 `data/MA-001.events.jsonl`（append-only 事件流）。

## 7. 下一步（可选，按需）

| 想要 | 做什么 | 文档 |
|---|---|---|
| 生产级看护（进程死了自动拉起、聋了重启、每日备份） | 注册看门狗计划任务 | [operations.md](operations.md) |
| 多维表格看板 + 知识库 + 术语表 | `npx tsx scripts/bitable-setup.ts` 等三个建表脚本 | [configuration.md](configuration.md#多维表格与知识库) |
| Jenkins CI 阶段 | `PIPELINE_PROJECTS` 里给项目加 `jenkins` 字段 + `JENKINS_*` | [configuration.md](configuration.md#jenkins) |
| 上线环节（审批后自动合并 MR） | `PIPELINE.md` 设 `release: merge-develop`，GitLab 用 PAT | [configuration.md](configuration.md#pipelinemd-项目流程约定) |
| 有测试环境、让运营真验 | `PIPELINE.md` 设 `testEnv: <url>`、`acceptor: ops` | 同上 |
| 用 Codex 做独立评审 | `codex login`，`PIPELINE.md` 设 `engine.review: codex` | [configuration.md](configuration.md#执行引擎) |
| 多项目、每项目一个群 | 群里 `/addproject` 接入，到目标群 `/bind` 绑定 | [ONBOARDING.md](../ONBOARDING.md) |
| 用 MR 评论触发独立评审（不走流水线） | `npm run webhook` + GitLab webhook | [configuration.md](configuration.md#gitlab) |
