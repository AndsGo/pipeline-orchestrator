# 排障

先跑 `npx tsx scripts/doctor.ts --no-infer`。下面按现象分组，每条都是真机发生过的。

## 启动与进程

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动脚本打印"已启动"，但群里没收到上线消息，`ps` 里也没 daemon | 日志文件被别的进程独占（如 `tail -f`），cmd 的 `>>` 重定向秒退且不报错 | 停掉占用方再启动。启动脚本现在会先探测并明说 |
| 启动报「检测到已有编排器进程在跑」 | 真有一个在跑（可能是看门狗拉起的） | 一个飞书应用只能一条长连接，别起第二个。要换代码走停止信号 |
| `-Stop` 杀不掉、`Get-Process` 看不到命令行、`process.kill(pid, 0)` 报 EPERM | daemon 是提权计划任务拉起的高完整性进程，普通 shell 无视野 | 不是死了。写 `data/daemon.stop`，等它自退 |
| daemon 无声消失，JS 层任何钩子都没触发 | Node 原生 fail-fast（退出码 0xC0000409），实测三次都在大批量嵌图写在线表时 | 已把在线表写回移到子进程；`logs/reports/` 有致命错误报告；外层 cmd 记录退出码区分「自己崩」与「被外力杀」 |
| 看门狗日志每两分钟一条「skip restart」，daemon 明明聋了 | 老版本 `-match` 大小写不敏感，skip 行里的小写 restart 刷新了节流时间戳 | 已改 `-cmatch`。升级看门狗脚本 |
| 每日备份连续失败：「文件正由另一进程使用」 | 某个监控工具攥着 `data/` 下一个文件，整包压缩全体失败 | 备份已改逐文件暂存、跳过被占用的并记名；别用 `tail -F` 盯 data 文件 |

## 飞书

| 现象 | 原因 | 处理 |
|---|---|---|
| 群里 @ 了没反应 | 没订阅 `im.message.receive_v1`；或应用没发布；或长连接被另一实例抢了 | 看 `logs/daemon.log` 有没有「收到消息」；`doctor` 查 token；确认单实例 |
| 卡片按钮点了没反应 | 没订阅 `card.action.trigger` 回调 | 开放平台加回调，重新发布版本 |
| 卡片里的表单/输入框整个不显示 | 该租户的卡片版本把 form 容器静默渲染为空 | 已不用 form，只用按钮；自由输入走群消息 |
| 引用一张卡片回话，机器人说「interactive 消息，未解析」 | 拉回来的卡片是 post 形状，文字在 `text` 不在 `content` | 已修（`renderCardText` 兼容三种形状）；需要 `im:message.group_msg` 权限 |
| 引用了 A 项目的结果卡，续到了 B 项目的会话 | 旧版「最近一次 /run」是全局指针 | 已改按群指针 + 结果卡 → 会话映射；引用哪张卡续哪次 |
| `/re` 回复被拒「最近 24 小时内没有可继续的记录」 | 续聊 TTL 24 小时 | 现在会列出再往前一次执行问你要不要接；或引用那张结果卡回话 |
| 「全部通过，但是我还想…」新需求被灌进每一项备注 | 批量回答把表决后的整段当公共补充 | 已拆：通过归通过，长句弹卡问要不要开新单 |
| 意图识别把握只有 50% 多，反复弹确认卡 | 分类模型太小 | `PIPELINE_CLASSIFY_MODEL=sonnet`（haiku 实测 5/8 不够用） |
| 富文本消息 `/new` 被判成没听懂 | `<p></p>` 残片没剥 | 已改结构化 runs 优先解析 |

## 流水线行为

| 现象 | 原因 | 处理 |
|---|---|---|
| 重启后说「继续」，工单跳过审批直接开始写代码 | 老版本在弹卡**之前**推游标并落盘，卡随内存丢了 | 已修：卡点持久化（`pendingGate`），重启后原样重发。这是最严重的一类缺陷，升级请优先 |
| 「继续」后重跑了整个 clarify / plan | 同上的老版本行为 | 同上 |
| 阶段返回 `BLOCKED`「写权限未授予」 | 该阶段白名单缺 `Edit`（compound 曾如此） | 见 `src/config.ts`，白名单与预算旁有调参史 |
| implement 第一批就 BLOCKED 且零代码，报「分支上无实现提交」，但随后 git log 里有提交 | 控制会话在子代理仍在后台跑时提前返回 | skill 0.12.1 已加硬约束：子代理未收工不得返回；台账 `Task N: complete` 行是断点恢复依据 |
| implement 分批续跑说「已完成 0/4」但台账明明有完成行 | 完成行写成反引号包裹、无列表符，旧正则只认「- 」开头 | 已放宽行首符号 |
| 评审 r2 又 BLOCK 同一类问题 | 修共享函数只接了一个调用入口，漏了别的 | 评审 skill 已加「横切改动全入口核查」；修复时对照评审列出的全部消费点 |
| 会话异常 `API Error: 529 Overloaded`，工单干等 | 服务端过载 | 已加瞬时故障自动重试：等 3 分钟同参数重跑一次，再失败才转人工 |
| Codex 评审第一秒崩 `unexpected argument` | 起进程经了 shell，提示词被拆参数 | 已改 node 直跑 `codex.js`；可用 `PIPELINE_CODEX_BIN` 显式指定 |
| Codex 返回被契约校验打回 `invalid_json_schema` / 缺 `axes.worst` | OpenAI 严格模式要求全属性 required；一刀切剥 null 误删了必填可空字段 | 已修：schema 转严格形态 + 只剥原可选字段的 null |
| Codex 评审工件写到了主检出而不是 worktree | 会话为跑 diff 溜进主检出 | 桥接提示词钉死工作根；主检出里多出来的工件会被搬回 |
| Codex 阶段成本显示 $0.00 | 没配价目表 | `.env` 加 `PIPELINE_CODEX_PRICE_IN / _CACHED / _OUT`（每百万 token 美元） |
| 上线审批卡说「未找到开着的 MR」 | GitLab token 是项目访问令牌，只看得到它所属项目 | 换个人访问令牌（PAT，`api` 范围） |
| 合并 MR 返回 405 但其实合并成功了 | GitLab 合并 API 异步，PUT 可能回 405 | 已改：非 2xx 回查 MR 状态，已 merged 当成功 |
| 验收卡让运营去点一个不存在的功能 | 项目没有测试环境，流水线不知道 | `PIPELINE.md` 设 `testEnv: none`，人工项转上线后补验 |

## 仓库与工件

| 现象 | 原因 | 处理 |
|---|---|---|
| PRD / 评审 / 原型不在 MR 里，换 worktree 就丢 | 目标仓库 `.gitignore` 屏蔽了 `docs` | 把 `docs` 改成 `docs/*` 再加 `!docs/pipeline/`（`!docs/pipeline/` 单独不起作用——父目录整个被忽略时子路径放不开）。`doctor` 与 `/addproject` 会点名 |
| 沉淀采纳的 CLAUDE.md 只在本机，MR 与回退路径都提交失败 | `.gitignore` 屏蔽了 `CLAUDE.md` | 删掉那行。`doctor` 会点名 |
| 主检出里有工单的未跟踪临时脚本 | 早期 `/run` 会话用 Bash 写了文件 | `/run` 提示词已禁止用 Bash 改写仓库；残留手动清 |
| 目标仓库不能全新安装，实现阶段花 $5 排雷 | 仓库自身的问题（stored compute + tracking 字段在 init 阶段崩） | 写进该项目的 `PIPELINE.md` 的 `## implement` 节：复用已建好的测试库。**首单的学费要记进项目约定** |

## 成本异常

| 现象 | 原因 | 处理 |
|---|---|---|
| 一张中等工单花了 $80+ | 首单：环境排雷 + 计划缺陷 + opt-in 参数引发两轮评审 | 看 `90-retro.md`；把教训写进 `PIPELINE.md`，下一单会便宜一大截 |
| implement 会话在半途死掉 | 只抬了轮数没抬预算（或反过来） | `src/config.ts` 两个数一起调 |
| 评审重跑结论不同 | 评审有非确定性 | `PIPELINE_DOUBLE_REVIEW=1` 双评审取严（+$3/单）；或 `engine.review: codex` 异构评审 |

## 还是不行

开 issue 时带上：`logs/daemon.log` 相关片段（脱敏）、`data/<ticket>.events.jsonl`、`doctor --no-infer` 输出、目标仓库的 `PIPELINE.md`。见 [CONTRIBUTING.md](../CONTRIBUTING.md#报告问题)。
