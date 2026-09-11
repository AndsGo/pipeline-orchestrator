# 话题维度的上下文管理（设计稿）

**状态**：已实现（2026-09-10，commit 见 git log；真机字段取值待首个话题消息验证） · **日期**：2026-09-09 · **范围**：编排器（`src/feishu/`、`src/daemon*`、`src/followup.ts`），不动阶段 skill 与 handoff 契约

## 0. 一句话

对话上下文的键从「群」换成「话题根消息 ?? 群」；工单与话题建立绑定；意图分类器从「猜你在跟谁说话」降级为群主线的兜底。**工单上下文不受影响**——它一直在磁盘工件里，与群、话题都无关。

## 1. 为什么现在做

三个已发生的事故是同一个根因——**群维度分不清「你在跟谁说话」**：

| 日期 | 现象 | 根因 |
|---|---|---|
| 2026-09-04 | 引用 lakeghost 结果卡续聊，按全局指针续到了 odoo-product 的会话 | 「最近一次 /run」是全局指针 → 已改为按群（`last-run.<chat>.json`），仍是群粒度 |
| 2026-09-07 | 同一话题连发三条，只有打了 `/re` 的那条续上会话，另两条各开新会话重读代码 | 续聊靠 `parent_id`（引用回复），话题里第二句起 `parent_id` 是上一条人话不是卡 |
| 2026-09-09 | LS-016 卡片开着时说「这些人工号重了」，被判成 followup 复活了早上一次无关 /run | 群里同时有工单在等答复和一次 /run 指针，分类器只能凭旁证猜；补丁=有卡在等就压制 followup（`commands.ts` `offerFollowup`） |

另外一个体验缺口：话题里 @bot 提问，bot **收得到、答不进去**——所有出站都是 `im.message.create` 到 `chat_id`（`src/feishu/port.ts:186`、`:375`），永远落群主线，对话在两个地方各半截。

## 2. 今天的上下文长什么样

「上下文」其实是两种东西，先拆开：

| 种类 | 载体 | 键 | 结论 |
|---|---|---|---|
| **工单上下文** | `docs/pipeline/<ticket>/` 工件 + `data/<ticket>.json` | 工单号 | 与群无关；群只是卡片投递地址（`chatFor(ticket)`）。阶段会话每次新开、读文件——**文件是真源，本设计不碰它** |
| **对话上下文** | claude `--resume` 会话（盘上会话文件，按 cwd 存） | 群 | `last-run.<chat>.json`（本群最近一次，24h TTL，`followup.ts:187`）+ `run-sessions.json`（结果卡 message_id → `LastRun`，`followup.ts:152/167`） |

`LastRun`（`followup.ts:26`）= `{ at, project, command, output, chain, sessionId?, origin? }`。`sessionId` 有就 `--resume` 真续，没有/失效走拼接降级。

入站消息（`IncomingMessage`，`port.ts:64`）今天只带 `chatId / text / mentioned / sender / messageId / quotedMessageId(=parent_id)`。**没有 `root_id` / `thread_id`**。

## 3. 目标模型：话题 = 会话

### 3.1 作用域层级

```
项目（知识库 / 术语表 / 仓库）
 └─ 群（默认投递地址；工单绑定群）
     └─ 话题（一段对话：最多绑 1 个 resume 会话、最多绑 1 个工单）
         └─ 消息（引用指针：精确指向某张卡 / 某次会话）
```

核心不变量：**一个话题 ↔ 至多一个活会话 ↔ 至多一个工单**。

### 3.2 存储：`data/threads.json`

```jsonc
{
  "<root_id>": {
    "chatId": "oc_…",
    "project": "lakeghost",
    "ticket": "LS-018",          // 可选：工单话题
    "run": { /* LastRun */ },    // 可选：对话会话（含 sessionId）
    "createdAt": "…", "lastAt": "…", "turns": 7
  }
}
```

- `root_id` = 话题根消息 id，飞书话题内每条消息都带，天然稳定。
- 现有 `run-sessions.json`（卡 message_id → LastRun）是本表的特例：卡就是根。迁移期两表并存，读时先查 `threads.json` 再回落 `run-sessions.json`；不做一次性迁移脚本，旧指针 24h 自然过期。
- `last-run.<chat>.json` **保留**，只服务群主线兜底（§3.4 第 5 条）。
- 写入 best-effort，同 `hits.ts` 风格：记不上不影响主流程。

### 3.3 入站：多带两个字段

`IncomingMessage` 增加 `rootId?: string`、`threadId?: string`（`im.message.receive_v1` 的 `message.root_id` / `message.thread_id`；SDK 类型未枚举，**需真机实测一次**确认字段名与「话题回复」vs「引用回复」时各自的取值）。

`parent_id` 语义保持「引用」；`root_id` 是「话题」。两者可同时出现（话题里引用某条）。

**真机取值（2026-09-10 验证）**：话题内每条消息 `root_id` = 话题根消息 id，`thread_id` = `omt_…` 非空；**`parent_id` 恒等于 `root_id`**（不只首条回复）——所以话题根若是文件/卡片，它会作为「引用内容」自动附到话题里每一句上（根是文件时文件已落 `data/quoted/`，会话可 Read）。普通引用回复无 `thread_id`。

### 3.4 判定顺序（确定性优先，猜测兜底）

```
1. 引用了某张结果卡 / 问题卡          → 那张卡的会话 / 工单          （今天已有：runByCard、tryAnswerByText）
2. 在话题里，话题绑了工单             → 该工单的 answer / note / amend  分类器只判「动作」，不判「哪张单」
3. 在话题里，话题有会话               → followup，--resume 它            不再看「群里有没有卡在等」
4. 在话题里，什么都没绑               → 新 run；完成后把 sessionId 写回该话题
5. 群主线                            → 今天的逻辑（有卡在等 > 24h 内 last-run > 新 run）
```

第 2 条是最大的收益：话题里的任何一句都**确定属于这张单**，`commands.ts` 里 `offerFollowup` 那个「有卡在等就压制 followup」的补丁在话题路径上可以拆掉（群主线兜底路径保留）。

### 3.5 出站：回到发问的地方

| 消息 | 去向 |
|---|---|
| 单次执行结果卡、追问、`notify('指令', …)` 这类**对话回应** | 消息来自话题 → `im.message.reply(replyInThread: true)` 回该话题；来自主线 → 照今天发主线 |
| 工单的问题卡、卡点卡、验收结果表、进度行、出错行 | 工单有绑定话题 → 进话题；没有 → 主线 |
| 开工 / 收尾 / 上线 / 闭环这类**广播** | 永远主线（业务受众版见 `src/voice.ts`），**同时**在工单话题里再发一份短的（一行，无卡片） |

SDK 已支持：`node_modules/@larksuiteoapi/node-sdk/lib/index.js` 有 `reply_in_thread: args.replyInThread`。`InteractionPort.notify(ticket, message, chatId?)` 现有第三个参数是「回到消息来源群」，扩成 `{ chatId?, rootId? }` 一个 origin 对象即可，调用方不用改。

### 3.6 工单话题（可选开关，建议默认开）

`工单建立` 那条消息由 bot 用 `reply_in_thread` 回一句（如「这张单的问答都在这个话题里」），话题就开出来了；`threads.json` 里 `root_id → ticket` 绑定。此后：

- 该工单的卡片和进度进话题（§3.5），主线只留广播——**多单并跑时主线不再交错**（LS-016 / LS-017 并跑时主线两单穿插，是业务方最难读的一段）。
- 工单结束（`done` / `halt` 事件）后话题绑定保留 7 天供追问，之后只读。

实现钩子：`appendEvent({type:'ticket.created'})` 之后（`ticketRunner.ts` 建单处）。

### 3.7 会话寿命与并发

- **寿命**：`--resume` 会话越长越贵。话题会话 **30 轮或 7 天不活跃**后，下一句开新会话，把旧会话最后一次 `output` 前 600 字作为「上文摘要」注入首轮提示（复用 `composeFollowupPrompt` 的拼接降级路径）。`turns` 字段就是为这个计的。
- **并发**：同一话题内串行（一个会话不能被两句话同时 resume——第二句排队并提示「上一句还在跑」）；话题之间并行，仍受全局 `Semaphore(maxConcurrency)`（`daemon.ts:47`）。
- **跨话题引用**：第 1 条规则覆盖，不特殊处理。
- **主线不废**：不习惯点「话题回复」的人在主线 @bot 带工单号照样能用，精度回到今天的水平。

## 4. 不做 / 明确边界

- 不改阶段 skill、不改 handoff 契约、不改工单状态机。
- 不把工单上下文（工件）搬进会话——文件仍是唯一真源。
- 不做「一个话题多个工单」：话题里 `/new` 第二张单 → 新单开自己的话题，并在当前话题回一句链接。
- 不迁移历史 `run-sessions.json`。

## 5. 改动清单与量

| # | 改动 | 文件 | 量 |
|---|---|---|---|
| 1 | 入站解析 `root_id` / `thread_id`，`IncomingMessage` 加字段 | `feishu/port.ts` | 小 |
| 2 | `threads.json` 读写 + 寿命判断（纯函数，可单测） | 新 `src/threads.ts` | 中 |
| 3 | `notify` / `sendResult` / 卡片投递支持 `replyInThread` | `feishu/port.ts`、`ports.ts` | 中 |
| 4 | daemon 判定顺序改成 §3.4；话题路径拆 `offerFollowup` 补丁 | `daemon.ts`、`daemon/adhoc.ts`、`commands.ts` | 中 |
| 5 | 工单话题：建单开话题、卡片路由到话题 | `ticketRunner.ts`、`feishu/port.ts` `chatFor` | 中 |
| 6 | 话题内串行队列 | `daemon/adhoc.ts` | 小 |
| 7 | 真机实测：话题回复 / 引用回复 / 话题内引用 三种事件的字段取值 | — | 0.5h |

合计约 **1 天**。1→2→3→4 是主线，5 与 6 可各自独立上。

## 6. 验证

- 单测：`threads.ts` 的读写 / 寿命 / 迁移回落；判定顺序 5 条各一例（含「话题绑单 + 卡在等 + 有 last-run」的三重冲突用例，断言走第 2 条）。
- 真机脚本：主线 `/run` → 结果卡 → 在卡上开话题连发三句 → 三句都续同一 `sessionId`；同时另一话题 `/run` 不串。
- 回归：`skill-eval` 不涉及（不改 skill）；现有 396 个单测须全绿。

## 7. 拍板记录（2026-09-10）

1. 工单话题：**默认开**，不加开关。
2. 广播消息：**在工单话题里复制一行**（纯文本，无卡片）。
3. 会话寿命：**30 轮 或 7 天不活跃**，采纳。

## 8. 修订（2026-09-11）：话题里只 @ 才触发

真机一天后的两条反馈：同事间在话题里讨论，每句都触发一轮 resume（贵、吵）；确认消息复述「继续上次执行《…》（续聊第 N 轮）」并拖着根消息的引用附件，不可读。拍板：

- **触发**：话题里只有 @机器人（或斜杠指令）才动手。不 @ 的话**攒着**（每话题 20 条 / 24 小时，`threads.json` 的 `pending`），下一次有人 @ 时连同那句一起交给会话/工单说明/需求原文，并回一句「已连同上面 N 条讨论一起处理」。攒着期间机器人完全沉默（连表情都不加）。
- **例外**：工单话题里答卡（「通过」「Q1 不通过 xxx」这类明确格式）不 @ 也落卡——格式明确、误伤概率低、是流水线的关键输入。
- **确认**：话题里不再发文字确认，给触发消息加 👀 表情；结果卡回来即完成。主线保留一句短确认，去掉「第 N 轮 / 已带上答复」。
- **引用**：话题里每条消息的 `parent_id` 都是根，已绑定的话题不再每句重拉根消息拼进正文（会话第一轮已带着它）；记录与复述只留人说的话（`stripQuote`）。
- §3.4 第 2～4 条的「不用 @」相应作废；判定顺序本身不变。
