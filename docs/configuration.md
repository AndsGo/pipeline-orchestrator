# 配置参考

三层配置，各管一件事：

| 层 | 文件 | 管什么 | 改了要不要重启 |
|---|---|---|---|
| 环境变量 | `.env` | 凭据、项目注册表、全局行为开关 | 要（`/addproject` 热加载的项目除外） |
| 项目流程约定 | 目标仓库 `docs/pipeline/PIPELINE.md` | 这个项目怎么测、谁验、怎么上线、用哪个引擎 | 不要，下一阶段生效 |
| 阶段参数 | `src/config.ts` | 每阶段的模型、轮数、预算、工具白名单 | 要，且是改代码 |

## 环境变量

复制 `.env.example` 为 `.env`。保持 UTF-8；轮换凭据只改对应行。

### 飞书（必填）

| 键 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 自建应用凭证 |
| `FEISHU_CHAT_ID` | 主群 chat_id（`oc_` 开头）。daemon 启动后 `node scripts/list-chats.mjs` 可列出 |
| `FEISHU_OWNER_OPEN_ID` | 可选。看板、云文档的归属人；不填归机器人所有，人看不到 |

### 项目注册表（必填）

```dotenv
PIPELINE_PROJECTS={"lakeghost":{"repo":"D:/work/lake_spirit","prefix":"LS","gitlab":"group/project","jenkins":"job-name","wikiArchive":"wikcnXXX","wikiKnowledge":"wikcnYYY"}}
```

一行 JSON，别名 → 对象：

| 字段 | 必填 | 说明 |
|---|---|---|
| `repo` | ✓ | 本地 clone 路径 |
| `prefix` | ✓ | 工单号前缀（`LS` → `LS-001`）；多项目间不得冲突（`doctor` 会查） |
| `gitlab` | | GitLab 项目路径 `group/name`。上线环节找 MR、评审服务映射仓库都靠它 |
| `jenkins` | | Jenkins 任务名（支持 `folder/job`）。配了才走 CI 阶段。**不再兜底全局 `JENKINS_JOB`**——曾差点用 A 项目的工单触发 B 项目的构建 |
| `wikiArchive` / `wikiKnowledge` | | 交付文档与知识条目的 wiki 归档节点 |
| `chatId` | | 绑定的飞书群。群里 `/bind <别名>` 会写进来，不用手填 |

群里 `/addproject` 或终端 `npx tsx scripts/add-project.ts` 会帮你写这一行并热加载。

### GitLab

| 键 | 说明 |
|---|---|
| `GITLAB_URL` | 实例地址 |
| `GITLAB_API_TOKEN` | **个人访问令牌**（`api` 范围）。项目访问令牌只看得到一个项目，多项目部署会静默找不到 MR |
| `GITLAB_WEBHOOK_SECRET` | MR 评论评审服务的 webhook 校验 |
| `GITLAB_REPO_MAP` | `{"group/project":"D:/work/local-clone"}`，评审服务用 |
| `GITLAB_TRIGGER` | MR 评论触发词，默认 `@ai-review` |
| `GITLAB_WEBHOOK_PORT` | 默认 8377，同时承载结果预览页 |
| `PREVIEW_BASE_URL` | 业务人员点开预览页的地址，如 `http://10.0.x.x:8377`。不配则卡片只写文件路径 |

### Jenkins

| 键 | 说明 |
|---|---|
| `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN` | 用户 API token（免 CSRF crumb）。配了 `jenkins` 任务名的项目必须同时配这三项 |
| `JENKINS_TIMEOUT_MIN` | 构建等待上限，默认 30 |

### 多维表格与知识库

全部可选。缺则看板投影、知识注入、术语注入静默跳过。

| 键 | 由谁创建 |
|---|---|
| `BITABLE_APP_TOKEN` / `BITABLE_TICKET_TABLE_ID` / `BITABLE_NODE_TABLE_ID` | `npx tsx scripts/bitable-setup.ts` |
| `BITABLE_KB_TABLE_ID` | `npx tsx scripts/kb-setup.ts` |
| `BITABLE_GLOSSARY_TABLE_ID` | `npx tsx scripts/glossary-setup.ts` |
| `WIKI_SPACE_ID` / `WIKI_ARCHIVE_NODE` / `WIKI_KNOWLEDGE_NODE` | `kb-setup.ts` |
| `WIKI_URL` | 只用于面板展示 |

### 行为开关（可选，有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `PIPELINE_PLUGIN_DIR` | `../pipeline-plugin` | skill 插件目录 |
| `PIPELINE_DATA_DIR` | `./data` | 状态与事件流目录（测试用它指向临时目录） |
| `PIPELINE_MAX_CONCURRENCY` | 2 | 同时执行的阶段会话数 |
| `PIPELINE_DEFAULT_REPO` | 注册表第一个 | 消息没指明项目时的默认 |
| `PIPELINE_CLASSIFY_MODEL` | sonnet | 意图识别模型。haiku 实测把握 5/8，勿降级 |
| `PIPELINE_RUN_MODEL` / `PIPELINE_RUN_BUDGET` | sonnet / 3 | `/run` 单次执行的模型与预算（美元） |
| `PIPELINE_DOUBLE_REVIEW` | 关 | 双评审取严（+$3/单），对冲评审非确定性 |
| `PIPELINE_BASE_REF` | 自动 | review diff 基点覆盖，如 `origin/master` |
| `PIPELINE_HINTS_OFF` | 关 | 对照模式：关闭知识/术语注入，面板与群里显式标注 |
| `PIPELINE_IMPLEMENT_MODEL` | opus | implement 主会话模型对照实验臂（`opus` / `sonnet`）；臂在首次 implement 时冻结进工单 |
| `PIPELINE_SCHEMA` | 插件内 schema | 契约 schema 路径覆盖（调试用） |

### Codex 引擎（有项目选了 codex 时）

| 键 | 默认 | 说明 |
|---|---|---|
| `PIPELINE_CODEX_BIN` | 自动定位全局 `@openai/codex` | codex 可执行文件路径覆盖 |
| `PIPELINE_CODEX_MODEL` | codex 自身默认 | 传给 `codex exec -m` |
| `PIPELINE_CODEX_PRICE_IN` / `_CACHED` / `_OUT` | 未配 | 每百万 token 美元价（输入 / 缓存输入 / 输出）。**不配则成本记 0 并在结果里注明「未计价」**，不会瞎猜 |

Codex 自己的登录态由 `codex login` 管理，编排器不接触。

### 已废弃

`PIPELINE_REPOS` 与 `PIPELINE_TICKET_PREFIX`（单项目时代）仍被读取以兼容老配置，新部署请用 `PIPELINE_PROJECTS`。

## `PIPELINE.md` 项目流程约定

放在目标仓库 `docs/pipeline/PIPELINE.md`，随代码入库。`/addproject` 与 `doctor` 会生成模板。**改完不用重启**，下一阶段读到。

### frontmatter 开关（编排器读）

| 键 | 取值 | 效果 |
|---|---|---|
| `testEnv` | `none`（默认）或地址 | `none`：验收的人工项不弹卡，全部记「无法验证」转上线后补验；有地址：人工项弹卡让验收人去实测，地址与 `testEnvNote` 原样出现在卡上 |
| `testEnvNote` | 文本 | 登录方式、账号在哪、注意事项。**不要写密码**（模板已注明"密码不入库，问项目负责人"） |
| `acceptor` | `dev`（默认）/ `ops` | `ops`：验收卡用业务措辞、不出现命令与路径 |
| `release` | `none`（默认）/ `merge-develop` / `merge-master` / `manual` | `none`：不设上线环节；`merge-*`：上线审批通过后拉目标分支干跑合并 → 无冲突 → API 合并 MR；`manual`：弹"请上线"卡，人做完点确认 |
| `engine` | `claude`（默认）/ `codex` | 全部阶段的执行引擎 |
| `engine.<stage>` | 同上 | 按阶段覆盖，如 `engine.review: codex` 做异构评审 |
| `e2e` | `playwright` | 验收/评审阶段带浏览器（Playwright MCP），页面类人工验收项先实测再留人工；需 `testEnv` 在跑 |
| `audience` | `it`（默认）/ `business` | 群消息受众。`business`：编排器模板说人话、带「走到第几步」锚点与下一步动作，不出现状态码/路径/分支/模型 |

### 正文分节（阶段会话读）

```markdown
## 全阶段      所有阶段都读：怎么建测试库、哪些目录不许碰、术语口径
## implement   跑测试的命令模板、不能全新安装的原因与替代做法、已知存量红灯
## review      必须核查的共享入口、可用的只读数据源
## acceptance  验收样例数据在哪、人工项怎么做、哪些注定只能上线后补验
## release     上线前还要过谁的审批、合并后要不要手动升级模块、上线后去哪看效果
```

每个阶段开工前，编排器把「全阶段」+ 该阶段一节抄进工单目录的 `07-project-profile.md`，skill 先读它，与通用流程冲突时以它为准。**写事实与硬约束，不写单个工单的流水账**——单个工单的经验由 compound 沉淀到知识库。

一个真实例子（odoo 项目，首单花 $80 的教训全在这里）：

```markdown
---
testEnv: https://distribution-test.example.com
testEnvNote: 用运营账号登录，账号在项目负责人处；升级模块后需清缓存
acceptor: ops
release: merge-develop
---
## 全阶段
- 本仓库不能全新安装（stored compute + tracking 字段在 init 阶段崩），复用已建好的测试库 `odoo_test`
- 不要给现有 Odoo 模块加 opt-in 参数，历史上两轮评审都因此打回
## implement
- 测试命令：`odoo-bin -d odoo_test -i <模块> --test-enable --stop-after-init`
## release
- 合并 develop 后 Jenkins 自动部署到测试环境；生产上线另走审批，不在流水线内
```

## 阶段参数（`src/config.ts`）

| 阶段 | 模型 | 轮数 | 预算 | 白名单 |
|---|---|---|---|---|
| clarify | opus | 60 | $16 | Read, Grep, Glob, Write, Edit |
| plan | opus | 120 | $14 | Read, Grep, Glob, Write, Edit |
| implement | opus | 300 | $25 | 含 Bash、Task（子代理） |
| review | opus | 100 | $10 | Read, Grep, Glob, Write, Bash（**无 Edit**） |
| acceptance | sonnet | 80 | $8 | 含 Bash |
| compound | sonnet | 100 | $8 | 含 Bash、Edit |

每个数字旁边有调参史注释。两条纪律：**轮数与预算一起调**（只抬一个，约束从这头搬到那头，会话照样半途死）；**白名单是权限边界**（评审没有 Edit 是设计，不是遗漏）。

## 会话设置（`config/pipeline-settings.json`）

阶段会话以 `--settings` 加载。它禁用会向每个会话注入自身流程规则的元框架插件（engineering-workflow、ralph-loop、codex 插件）——两层流程控制会静默打架，曾把外层框架的流程要求写进 PRD。如果你的 Claude Code 装了别的同类插件，加进 `disabledPlugins`。
