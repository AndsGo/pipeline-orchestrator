import { describe, expect, it } from 'vitest';
import { buildDashboard, formatUptime, renderDashboard, type RuntimeInfo, type TicketRow } from '../dashboard.js';

const env = {
  PIPELINE_PROJECTS: JSON.stringify({
    lakeghost: { repo: 'D:/work/lake_spirit', prefix: 'LS', gitlab: 'songxulin/lakeghost', jenkins: 'lake-deploy' },
  }),
  GITLAB_URL: 'http://git.happotech.com',
  GITLAB_TRIGGER: '@ai-review',
  BITABLE_APP_TOKEN: 'TitVbp123',
  WIKI_URL: 'https://euj0e90can.feishu.cn/wiki/RlEK',
  JENKINS_URL: 'http://jenkins.hbo-vps.com',
  JENKINS_JOB: 'deploy/app',
  PIPELINE_DOUBLE_REVIEW: '1',
} as unknown as NodeJS.ProcessEnv;

const rt: RuntimeInfo = {
  startedAt: 0,
  now: 3 * 3600_000 + 25 * 60_000,
  concurrency: { inUse: 1, max: 2, waiting: 0 },
  activeTickets: ['LS-004'],
  pendingCards: 2,
  boardEnabled: true,
};

const rows: TicketRow[] = [
  { ticket: 'LS-004', stage: 'implement', state: '在跑', cost: 29.61, waiting: '等回答：Q1、Q3' },
  { ticket: 'LS-003', stage: '已闭环', state: '闭环', cost: 26.29 },
];

describe('运行面板数据装配', () => {
  it('配置区按项目列出仓库链接（含前缀与 CI 任务），并汇总看板/知识库/Jenkins', () => {
    const { config } = buildDashboard(env, rt, rows);
    const byLabel = Object.fromEntries(config.map((c) => [c.label, c]));
    expect(byLabel['项目 lakeghost'].url).toBe('http://git.happotech.com/songxulin/lakeghost');
    expect(byLabel['项目 lakeghost'].value).toContain('LS-'); // 工单号前缀
    expect(byLabel['项目 lakeghost'].value).toContain('CI lake-deploy'); // CI 任务按项目显示
    expect(byLabel['多维表格看板'].url).toBe('https://feishu.cn/base/TitVbp123');
    expect(byLabel['知识库'].url).toContain('/wiki/');
    expect(byLabel['Jenkins'].url).toBe('http://jenkins.hbo-vps.com/job/deploy/job/app'); // folder 形式展开
    expect(byLabel['MR 评审服务'].value).toContain('@ai-review');
  });

  it('未配置的项不出现，不留空占位', () => {
    const { config } = buildDashboard({} as NodeJS.ProcessEnv, rt, []);
    expect(config).toEqual([]);
  });

  it('运行区反映闸门、在跑数、待答数与开关状态', () => {
    const { runtime } = buildDashboard(env, rt, rows);
    const v = Object.fromEntries(runtime.map((r) => [r.label, r.value]));
    expect(v['已运行']).toBe('3 小时 25 分钟');
    expect(v['并发闸门']).toBe('1/2');
    expect(v['工单']).toBe('2 个，其中在跑 1');
    expect(v['待人回答']).toBe('2 项');
    expect(v['看板投影']).toBe('已启用');
    expect(v['双评审']).toContain('开启');
  });

  it('排队中的会话数会显示出来', () => {
    const { runtime } = buildDashboard(env, { ...rt, concurrency: { inUse: 2, max: 2, waiting: 3 } }, rows);
    expect(runtime.find((r) => r.label === '并发闸门')!.value).toBe('2/2（排队 3）');
  });

  it('运行时长跨度：分钟 / 小时 / 天', () => {
    expect(formatUptime(90_000)).toBe('1 分钟');
    expect(formatUptime(3 * 3600_000)).toBe('3 小时 0 分钟');
    expect(formatUptime(50 * 3600_000)).toBe('2 天 2 小时');
  });
});

describe('运行面板渲染', () => {
  it('工单行带状态图标、成本与"在等什么"', () => {
    const r = renderDashboard(buildDashboard(env, rt, rows));
    expect(r.tickets).toContain('🟢 **LS-004**');
    expect(r.tickets).toContain('$29.61');
    expect(r.tickets).toContain('等回答：Q1、Q3');
    expect(r.tickets).toContain('🏁 **LS-003**');
  });

  it('有 url 的配置项渲染成 markdown 链接', () => {
    const r = renderDashboard(buildDashboard(env, rt, rows));
    expect(r.config).toContain('](http://git.happotech.com/songxulin/lakeghost)');
  });

  it('多项目时工单按项目分组显示', () => {
    const multi = {
      ...env,
      PIPELINE_PROJECTS: JSON.stringify({
        lakeghost: { repo: 'D:/a', prefix: 'LS' },
        search: { repo: 'D:/b', prefix: 'SRCH' },
      }),
    } as unknown as NodeJS.ProcessEnv;
    const r = renderDashboard(
      buildDashboard(multi, rt, [
        { ticket: 'LS-004', project: 'lakeghost', stage: '已闭环', state: '闭环', cost: 42.79 },
        { ticket: 'SRCH-001', project: 'search', stage: 'implement', state: '在跑', cost: 3.2 },
      ]),
    );
    expect(r.tickets).toContain('_lakeghost_');
    expect(r.tickets).toContain('_search_');
    // 单项目时不加分组标题，避免多余噪音
    expect(renderDashboard(buildDashboard(env, rt, rows)).tickets).not.toContain('_lakeghost_');
  });

  it('无工单时给占位文案而不是空白', () => {
    const r = renderDashboard(buildDashboard(env, rt, []));
    expect(r.tickets).toContain('暂无工单');
  });
});
