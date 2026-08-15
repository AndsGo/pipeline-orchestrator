import { loadProjects } from './projects.js';

/**
 * 运行面板的数据装配（纯函数，可单测）。
 * 目的：把散在 .env 与内存里的东西汇成一屏——常用链接点得到，跑成什么样看得见。
 */

export interface DashItem {
  label: string;
  value: string;
  url?: string;
}

export interface TicketRow {
  ticket: string;
  project?: string;
  stage: string;
  state: string;
  cost: number;
  waiting?: string;
  url?: string;
}

export interface RuntimeInfo {
  startedAt: number;
  now: number;
  concurrency: { inUse: number; max: number; waiting: number };
  activeTickets: string[];
  pendingCards: number;
  boardEnabled: boolean;
  /** 本次运行期间的单次执行统计（/run） */
  adhoc?: { count: number; cost: number };
}

export interface DashboardData {
  config: DashItem[];
  runtime: DashItem[];
  tickets: TicketRow[];
}

export function formatUptime(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时 ${m % 60} 分钟` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function buildDashboard(env: NodeJS.ProcessEnv, rt: RuntimeInfo, tickets: TicketRow[]): DashboardData {
  const config: DashItem[] = [];

  // 每个项目一行：仓库链接 + 工单号前缀 + CI 任务，多项目时一眼看清各自接到哪
  for (const p of loadProjects(env)) {
    const bits = [`${p.prefix}-`, p.jenkins ? `CI ${p.jenkins}` : ''].filter(Boolean).join(' · ');
    config.push({
      label: `项目 ${p.alias}`,
      value: `${p.gitlab ?? p.repo}（${bits}）`,
      url: p.gitlab && env.GITLAB_URL ? `${env.GITLAB_URL.replace(/\/$/, '')}/${p.gitlab}` : undefined,
    });
  }
  if (env.BITABLE_APP_TOKEN) {
    config.push({ label: '多维表格看板', value: '工单 / 节点 / 知识', url: `https://feishu.cn/base/${env.BITABLE_APP_TOKEN}` });
  }
  if (env.WIKI_URL || env.WIKI_SPACE_ID) {
    config.push({ label: '知识库', value: env.WIKI_URL ? '需求档案 / 工程知识' : `space ${env.WIKI_SPACE_ID}`, url: env.WIKI_URL });
  }
  if (env.JENKINS_URL) {
    const job = env.JENKINS_JOB;
    config.push({
      label: 'Jenkins',
      value: job ?? '(未指定任务)',
      url: job ? `${env.JENKINS_URL.replace(/\/$/, '')}/job/${job.split('/').join('/job/')}` : env.JENKINS_URL,
    });
  }
  if (env.GITLAB_URL) {
    config.push({
      label: 'MR 评审服务',
      value: `:${env.GITLAB_WEBHOOK_PORT ?? 8377} · 触发词 ${env.GITLAB_TRIGGER ?? '@ai-review'}`,
    });
  }

  const runtime: DashItem[] = [
    { label: '已运行', value: formatUptime(rt.now - rt.startedAt) },
    { label: '并发闸门', value: `${rt.concurrency.inUse}/${rt.concurrency.max}${rt.concurrency.waiting ? `（排队 ${rt.concurrency.waiting}）` : ''}` },
    { label: '工单', value: `${tickets.length} 个，其中在跑 ${rt.activeTickets.length}` },
    { label: '待人回答', value: rt.pendingCards ? `${rt.pendingCards} 项` : '无' },
    { label: '看板投影', value: rt.boardEnabled ? '已启用' : '未配置' },
    ...(rt.adhoc?.count ? [{ label: '临时执行', value: `${rt.adhoc.count} 次 · $${rt.adhoc.cost.toFixed(2)}` }] : []),
    { label: '双评审', value: env.PIPELINE_DOUBLE_REVIEW === '1' ? '开启（取严）' : '关闭' },
  ];

  return { config, runtime, tickets };
}

/** 工单按项目分组：多项目并行时，一屏里各项目的进展要分得开 */
function renderTicketsByProject(rows: TicketRow[], mark: (s: string) => string): string {
  const groups = new Map<string, TicketRow[]>();
  for (const t of rows) {
    const k = t.project ?? '未归属';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const multi = groups.size > 1;
  return [...groups.entries()]
    .map(([proj, list]) => {
      const body = list
        .map(
          (t) =>
            `${mark(t.state)} **${t.ticket}**　${t.stage}　$${t.cost.toFixed(2)}` +
            (t.waiting ? `\n　　└ ${t.waiting.slice(0, 60)}` : ''),
        )
        .join('\n');
      return multi ? `_${proj}_\n${body}` : body;
    })
    .join('\n\n');
}

/** 渲染成卡片正文（markdown），链接可点 */
export function renderDashboard(d: DashboardData): { config: string; runtime: string; tickets: string } {
  const line = (i: DashItem): string => `**${i.label}**　${i.url ? `[${i.value}](${i.url})` : i.value}`;
  const mark = (s: string): string => (s === '在跑' ? '🟢' : s === '挂起' ? '⛔' : s === '闭环' ? '🏁' : '⏸️');
  return {
    config: d.config.length ? d.config.map(line).join('\n') : '（未配置）',
    runtime: d.runtime.map(line).join('\n'),
    tickets: d.tickets.length ? renderTicketsByProject(d.tickets, mark) : '（暂无工单）',
  };
}
