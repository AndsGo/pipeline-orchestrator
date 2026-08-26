/**
 * 项目维度：把仓库、工单号前缀、GitLab 项目、Jenkins 任务、Wiki 归档节点收成一处定义。
 * 改造前这些散在四个环境变量里，其中 JENKINS_JOB 与 WIKI_ARCHIVE_NODE 还是单值——
 * 接第二个项目会静默打错构建任务、归错档，所以项目必须是一等公民。
 */

export interface Project {
  alias: string;
  /** 本地仓库路径 */
  repo: string;
  /** 工单号前缀，如 LS → LS-006 */
  prefix: string;
  /** GitLab 项目路径 group/name */
  gitlab?: string;
  /** Jenkins 任务名（支持 folder/job） */
  jenkins?: string;
  /** Wiki 归档父节点 */
  wikiArchive?: string;
  wikiKnowledge?: string;
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 读取项目配置。优先 PIPELINE_PROJECTS；
 * 缺失时从旧的单项目变量拼一个出来，保证老配置不炸。
 */
export function loadProjects(env: NodeJS.ProcessEnv = process.env): Project[] {
  const raw = parseJson<Record<string, Partial<Project>>>(env.PIPELINE_PROJECTS, {});
  const list = Object.entries(raw).map(([alias, p]) => ({
    alias,
    repo: (p.repo ?? '').replace(/\\/g, '/'),
    prefix: p.prefix ?? alias.slice(0, 4).toUpperCase(),
    gitlab: p.gitlab,
    jenkins: p.jenkins,
    wikiArchive: p.wikiArchive,
    wikiKnowledge: p.wikiKnowledge,
  }));
  if (list.length) return list.filter((p) => p.repo);

  // 兼容旧配置（单项目形状）
  const repos = parseJson<Record<string, string>>(env.PIPELINE_REPOS, {});
  const projects = parseJson<Record<string, string>>(env.GITLAB_REPO_MAP, {});
  return Object.entries(repos).map(([alias, repo]) => ({
    alias,
    repo: repo.replace(/\\/g, '/'),
    prefix: env.PIPELINE_TICKET_PREFIX ?? alias.slice(0, 4).toUpperCase(),
    gitlab: Object.entries(projects).find(([, local]) => local.replace(/\\/g, '/') === repo.replace(/\\/g, '/'))?.[0],
    jenkins: env.JENKINS_JOB,
    wikiArchive: env.WIKI_ARCHIVE_NODE,
    wikiKnowledge: env.WIKI_KNOWLEDGE_NODE,
  }));
}

/** OSA 编辑距离（含相邻换位=1）：识别「navo→nova」这类手滑 */
function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * 从消息文本里认项目（多项目路由，2026-08-26 实测补的课）：
 * 「分析下 nova 项目」此前会静默落到默认项目——run 的解析链只认分类器不会填的 c.project；
 * 拼错的「navo」更是如此（当次靠会话自己用绝对路径圆场，但知识提示与续聊指针都记错了项目）。
 * exact=文本里原样出现别名；fuzzy=某个词与别名的 OSA 距离在阈值内（4-6 字母容 1 错，更长容 2 错）。
 * 多个别名都命中视为说不清，返回 null 交给调用方问人——绝不猜。
 */
export function mentionedProject(projects: Project[], text: string): { project: Project; exact: boolean } | null {
  const lower = text.toLowerCase();
  const exact = projects.filter((p) => lower.includes(p.alias.toLowerCase()));
  if (exact.length === 1) return { project: exact[0], exact: true };
  if (exact.length > 1) return null;
  const tokens = [...new Set(lower.match(/[a-z][a-z0-9-]{2,}/g) ?? [])];
  const sorted = (s: string): string => [...s].sort().join('');
  const fuzzy = projects.filter((p) => {
    const alias = p.alias.toLowerCase();
    const cap = alias.length <= 3 ? 0 : alias.length <= 6 ? 1 : 2;
    if (!cap) return false;
    return tokens.some(
      (t) =>
        (Math.abs(t.length - alias.length) <= cap && osaDistance(t, alias) <= cap) ||
        // 变位词：同长度且字母组成相同（「navo→nova」是隔位换位，OSA 距离 2 会漏）；
        // 不放宽 OSA 阈值本身——那会把 note 这类真单词也当成 nova 的手滑
        (t.length === alias.length && sorted(t) === sorted(alias)),
    );
  });
  return fuzzy.length === 1 ? { project: fuzzy[0], exact: false } : null;
}

/**
 * 项目的 CI 任务名：项目字段优先；全局 JENKINS_JOB 只在**单项目部署**时兜底。
 * 多项目共用全局 job = A 项目的工单触发 B 项目的构建（nova 验收实测，2026-08-26）——
 * 宁可让该项目不走 CI（直达验收），也不能跑错项目的构建。
 */
export function ciJobFor(project: Pick<Project, 'jenkins'> | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (project?.jenkins) return project.jenkins;
  return loadProjects(env).length > 1 ? undefined : env.JENKINS_JOB;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

/** 按别名 / 仓库路径 / 工单号前缀解析项目 */
export function resolveProject(projects: Project[], hint?: string): Project | null {
  if (!hint) return projects.length === 1 ? projects[0] : null;
  const byAlias = projects.find((p) => p.alias.toLowerCase() === hint.toLowerCase());
  if (byAlias) return byAlias;
  const byRepo = projects.find((p) => norm(p.repo) === norm(hint));
  if (byRepo) return byRepo;
  return projectOfTicket(projects, hint);
}

/** 从工单号推断项目（LS-006 → prefix LS） */
export function projectOfTicket(projects: Project[], ticket: string): Project | null {
  const m = /^([A-Za-z]+)-\d+$/.exec(ticket.trim());
  if (!m) return null;
  return projects.find((p) => p.prefix.toLowerCase() === m[1].toLowerCase()) ?? null;
}

/** 该项目下的下一个工单号：编号按项目独立递增，不同项目互不影响 */
export function nextTicketId(project: Project, existing: string[]): string {
  const re = new RegExp(`^${project.prefix}-(\\d+)$`, 'i');
  const max = Math.max(0, ...existing.map((t) => Number(re.exec(t)?.[1] ?? 0)).filter((n) => !Number.isNaN(n)));
  return `${project.prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** 供意图识别与提示用的一行描述 */
export function describeProjects(projects: Project[]): string {
  return projects.map((p) => `${p.alias}（工单号前缀 ${p.prefix}-）`).join('、');
}
