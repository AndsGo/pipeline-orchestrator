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
