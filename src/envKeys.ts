/**
 * .env 键目录：控制台展示 / 编辑与 daemon 热重载共用的一份事实。
 *
 * 三档语义（讨论稿 docs/design/2026-09-25-admin-console.md 决策 2）：
 * - 默认热生效：代码按调用时读 `env.X`，daemon 收到 reload 信号覆盖 process.env 即生效；
 * - restart：启动时冻结（飞书长连接、Semaphore、路径），改了只能等下次重启；
 * - secret：值永不下发到浏览器，页面只显示「已配置 + 长度」，修改是只写字段。
 * 不在目录里的键一律按 secret 对待——宁可多遮一个，不能漏一个。
 */

export interface EnvKeySpec {
  key: string;
  desc: string;
  secret?: boolean;
  /** 改后需重启哪个进程；缺省 = 热生效 */
  restart?: 'daemon' | 'web';
}

export interface EnvGroup {
  name: string;
  keys: EnvKeySpec[];
}

export const ENV_GROUPS: EnvGroup[] = [
  {
    name: '飞书',
    keys: [
      { key: 'FEISHU_APP_ID', desc: '自建应用 App ID', restart: 'daemon' },
      { key: 'FEISHU_APP_SECRET', desc: '自建应用 App Secret', secret: true, restart: 'daemon' },
      { key: 'FEISHU_CHAT_ID', desc: '主群 chat_id（综合入口）', restart: 'daemon' },
      { key: 'FEISHU_OWNER_OPEN_ID', desc: '交付文档的所有者 open_id' },
    ],
  },
  {
    name: '项目',
    keys: [{ key: 'PIPELINE_PROJECTS', desc: '项目表（一行 JSON；用「项目配置」页编辑）' }],
  },
  {
    name: 'GitLab',
    keys: [
      { key: 'GITLAB_URL', desc: 'GitLab 地址' },
      { key: 'GITLAB_API_TOKEN', desc: 'API token', secret: true },
      { key: 'GITLAB_WEBHOOK_SECRET', desc: 'webhook 校验密钥', secret: true, restart: 'web' },
      { key: 'GITLAB_REPO_MAP', desc: 'GitLab 项目路径 → 本地仓库（一行 JSON）' },
      { key: 'GITLAB_TRIGGER', desc: 'MR 评论触发词（默认 @ai-review）', restart: 'web' },
      { key: 'GITLAB_WEBHOOK_PORT', desc: 'web 服务端口：GitLab 评审 / 结果预览 / 控制台共用（默认 8377）', restart: 'web' },
      { key: 'GITLAB_DEFAULT_BRANCH', desc: '默认分支名（看板链接用，默认 master）' },
    ],
  },
  {
    name: 'Jenkins',
    keys: [
      { key: 'JENKINS_URL', desc: 'Jenkins 地址' },
      { key: 'JENKINS_JOB', desc: '全局 CI 任务（仅单项目部署时兜底）' },
      { key: 'JENKINS_USER', desc: '用户名' },
      { key: 'JENKINS_TOKEN', desc: 'API token', secret: true },
      { key: 'JENKINS_TIMEOUT_MIN', desc: '等构建的超时分钟数' },
    ],
  },
  {
    name: '多维表格',
    keys: [
      { key: 'BITABLE_APP_TOKEN', desc: '看板所在多维表格' },
      { key: 'BITABLE_TICKET_TABLE_ID', desc: '工单表' },
      { key: 'BITABLE_NODE_TABLE_ID', desc: '节点表' },
      { key: 'BITABLE_KB_TABLE_ID', desc: '知识表' },
      { key: 'BITABLE_GLOSSARY_TABLE_ID', desc: '术语表' },
      { key: 'BITABLE_REQ_TABLE_ID', desc: '需求池表' },
    ],
  },
  {
    name: 'Wiki',
    keys: [
      { key: 'WIKI_SPACE_ID', desc: '知识空间' },
      { key: 'WIKI_ARCHIVE_NODE', desc: '需求档案归档父节点（单项目兜底）' },
      { key: 'WIKI_KNOWLEDGE_NODE', desc: '系统地图父节点（单项目兜底）' },
      { key: 'WIKI_URL', desc: '知识库入口链接（面板展示用）' },
    ],
  },
  {
    name: '流水线',
    keys: [
      { key: 'PIPELINE_CLASSIFY_MODEL', desc: '意图识别模型' },
      { key: 'PIPELINE_RUN_MODEL', desc: '/run 单次执行模型' },
      { key: 'PIPELINE_RUN_BUDGET', desc: '/run 单次预算（美元）' },
      { key: 'PIPELINE_MAX_CONCURRENCY', desc: '并发闸门（默认 2）', restart: 'daemon' },
      { key: 'PIPELINE_DEFAULT_REPO', desc: '默认项目别名', restart: 'daemon' },
      { key: 'PIPELINE_DOUBLE_REVIEW', desc: '双评审（1 开启，取严）' },
      { key: 'PIPELINE_BASE_REF', desc: '评审 diff 基点' },
      { key: 'PIPELINE_PLUGIN_DIR', desc: 'pipeline-plugin 目录', restart: 'daemon' },
      { key: 'PIPELINE_HINTS_OFF', desc: '对照模式：关闭知识/术语注入（非空即开）' },
      { key: 'PIPELINE_IMPLEMENT_MODEL', desc: 'implement 主会话实验臂（opus / sonnet）' },
      { key: 'PIPELINE_DATA_DIR', desc: '运行时数据目录', restart: 'daemon' },
      { key: 'PIPELINE_SCHEMA', desc: '阶段结果 schema 路径', restart: 'daemon' },
    ],
  },
  {
    name: 'Codex',
    keys: [
      { key: 'PIPELINE_CODEX_BIN', desc: 'codex 可执行文件' },
      { key: 'PIPELINE_CODEX_MODEL', desc: 'codex 模型' },
      { key: 'PIPELINE_CODEX_PRICE_IN', desc: '输入单价（$/M tokens）' },
      { key: 'PIPELINE_CODEX_PRICE_CACHED', desc: '缓存命中单价' },
      { key: 'PIPELINE_CODEX_PRICE_OUT', desc: '输出单价' },
    ],
  },
  {
    name: '预览与控制台',
    keys: [
      { key: 'PREVIEW_BASE_URL', desc: '飞书卡片里结果预览的外链前缀（web 服务地址，如 http://10.0.x.x:8377）' },
      { key: 'CONSOLE_TOKEN', desc: '控制台访问口令（至少 8 位；不配则 web 服务不挂控制台）', secret: true, restart: 'web' },
    ],
  },
];

const SPECS = new Map(ENV_GROUPS.flatMap((g) => g.keys).map((k) => [k.key, k]));

/** 目录里没有的键按 secret 处理 */
export function envKeySpec(key: string): EnvKeySpec {
  return SPECS.get(key) ?? { key, desc: '（目录外的键）', secret: true };
}

/** 与 doctor.ts / 启动脚本同一口径：跳过注释行，按第一个 = 切分，键值去空白 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].trim();
  }
  return out;
}

export interface ReloadResult {
  /** 已覆盖进 process.env 的键 */
  applied: string[];
  /** 值变了但要重启 daemon 才生效的键 */
  deferred: string[];
}

/**
 * 把 .env 的新内容套进进程环境：热键覆盖，daemon 冻结键只记名。
 * 从 .env 删掉的键不清 process.env——启动脚本装载的环境是「有」的语义，删行更像手滑；要清值就写空。
 */
export function applyEnvReload(parsed: Record<string, string>, env: NodeJS.ProcessEnv = process.env): ReloadResult {
  const applied: string[] = [];
  const deferred: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if ((env[k] ?? '') === v) continue;
    if (envKeySpec(k).restart === 'daemon') deferred.push(k);
    else {
      env[k] = v;
      applied.push(k);
    }
  }
  return { applied, deferred };
}
