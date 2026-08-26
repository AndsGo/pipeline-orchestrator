import { describe, expect, it } from 'vitest';
import { filterByProject, type KnowledgeEntry } from '../knowledge.js';
import { ciJobFor, describeProjects, loadProjects, mentionedProject, nextTicketId, projectOfTicket, resolveProject } from '../projects.js';

const env = {
  PIPELINE_PROJECTS: JSON.stringify({
    lakeghost: { repo: 'D:/work/lake_spirit', prefix: 'LS', gitlab: 'songxulin/lakeghost', jenkins: 'lake-deploy', wikiArchive: 'PV1' },
    search: { repo: 'D:/work/demo/search', prefix: 'SRCH', jenkins: 'search-deploy', wikiArchive: 'PV2' },
  }),
} as unknown as NodeJS.ProcessEnv;

describe('消息文本认项目（「分析下 navo 项目」实测：正名会落默认项目，拼错更是）', () => {
  const ps = loadProjects({
    PIPELINE_PROJECTS: '{"lakeghost":{"repo":"D:/a","prefix":"LS"},"nova":{"repo":"D:/b","prefix":"NV"}}',
  } as NodeJS.ProcessEnv);

  it('原样提到别名 → exact 命中', () => {
    expect(mentionedProject(ps, '分析下 nova 项目')).toMatchObject({ exact: true, project: { alias: 'nova' } });
    expect(mentionedProject(ps, '看看 LAKEGHOST 的鉴权')).toMatchObject({ exact: true, project: { alias: 'lakeghost' } });
  });

  it('手滑拼错（换位/漏字）→ fuzzy 命中，交给调用方确认', () => {
    expect(mentionedProject(ps, '分析下 navo 项目')).toMatchObject({ exact: false, project: { alias: 'nova' } });
    expect(mentionedProject(ps, 'lakeghos 跑下测试')).toMatchObject({ exact: false, project: { alias: 'lakeghost' } });
  });

  it('没提项目 / 无关词 → null（回落默认，不乱认）', () => {
    expect(mentionedProject(ps, '跑一下前端测试')).toBeNull();
    expect(mentionedProject(ps, 'novel 不该命中')).toBeNull(); // 长度不同且距 2
    expect(mentionedProject(ps, 'note 不该命中')).toBeNull(); // 同长度但字母组成不同
  });

  it('同时提到多个项目 → null（说不清就问人，绝不猜）', () => {
    expect(mentionedProject(ps, '对比下 nova 和 lakeghost')).toBeNull();
  });
});

describe('CI 任务按项目解析（nova 验收实测，2026-08-26：全局兜底会让 NV- 工单触发 lakeghost 的构建）', () => {
  it('项目自己的 jenkins 字段永远优先', () => {
    expect(ciJobFor({ jenkins: 'my-job' }, { ...env, JENKINS_JOB: 'global-job' } as NodeJS.ProcessEnv)).toBe('my-job');
  });
  it('多项目部署时全局 JENKINS_JOB 不兜底——宁可不走 CI 也不跑错项目的构建', () => {
    expect(ciJobFor({}, { ...env, JENKINS_JOB: 'global-job' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it('单项目部署时全局兜底保留（存量 lakeghost 的配置方式）', () => {
    const single = {
      PIPELINE_PROJECTS: '{"only":{"repo":"D:/x","prefix":"ON"}}',
      JENKINS_JOB: 'global-job',
    } as NodeJS.ProcessEnv;
    expect(ciJobFor({}, single)).toBe('global-job');
  });
});

describe('项目配置', () => {
  it('解析多项目，各自带前缀/CI/归档节点', () => {
    const ps = loadProjects(env);
    expect(ps.map((p) => p.alias)).toEqual(['lakeghost', 'search']);
    expect(ps[0].jenkins).toBe('lake-deploy');
    expect(ps[1].jenkins).toBe('search-deploy'); // 关键：CI 任务按项目分开，不再是全局单值
    expect(ps[0].wikiArchive).not.toBe(ps[1].wikiArchive);
  });

  it('兼容旧的单项目配置（PIPELINE_REPOS + 全局 JENKINS_JOB）', () => {
    const legacy = {
      PIPELINE_REPOS: '{"lakeghost":"D:/work/lake_spirit"}',
      GITLAB_REPO_MAP: '{"songxulin/lakeghost":"D:/work/lake_spirit"}',
      PIPELINE_TICKET_PREFIX: 'LS',
      JENKINS_JOB: 'old-job',
      WIKI_ARCHIVE_NODE: 'PVold',
    } as unknown as NodeJS.ProcessEnv;
    const ps = loadProjects(legacy);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ alias: 'lakeghost', prefix: 'LS', gitlab: 'songxulin/lakeghost', jenkins: 'old-job' });
  });

  it('按别名 / 仓库路径 / 工单号前缀都能解析到项目', () => {
    const ps = loadProjects(env);
    expect(resolveProject(ps, 'search')?.alias).toBe('search');
    expect(resolveProject(ps, 'D:\\work\\lake_spirit')?.alias).toBe('lakeghost'); // 反斜杠也认
    expect(resolveProject(ps, 'SRCH-002')?.alias).toBe('search');
    expect(resolveProject(ps, '不存在')).toBeNull();
  });

  it('多项目且无提示时不猜（返回 null，交给上层问人）', () => {
    expect(resolveProject(loadProjects(env), undefined)).toBeNull();
    const single = loadProjects({ PIPELINE_PROJECTS: '{"a":{"repo":"/x","prefix":"A"}}' } as never);
    expect(resolveProject(single, undefined)?.alias).toBe('a'); // 只有一个项目时可以直接用
  });

  it('工单编号按项目独立递增，互不影响', () => {
    const ps = loadProjects(env);
    const existing = ['LS-004', 'LS-005', 'SRCH-001'];
    expect(nextTicketId(ps[0], existing)).toBe('LS-006');
    expect(nextTicketId(ps[1], existing)).toBe('SRCH-002');
    expect(nextTicketId(ps[1], [])).toBe('SRCH-001');
  });

  it('工单号前缀能反查项目；无前缀的编号返回 null', () => {
    const ps = loadProjects(env);
    expect(projectOfTicket(ps, 'LS-006')?.alias).toBe('lakeghost');
    expect(projectOfTicket(ps, 'XX-001')).toBeNull();
  });

  it('describeProjects 给出人可读的项目与前缀', () => {
    expect(describeProjects(loadProjects(env))).toContain('lakeghost（工单号前缀 LS-）');
  });
});

describe('知识按项目软隔离', () => {
  const e = (over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
    title: 't',
    kind: '踩坑',
    tags: [],
    symptom: '',
    cause: '',
    practice: '',
    ...over,
  });

  it('本项目的全部保留；他项目的仅当适用范围非"本项目"时才跨项目复用', () => {
    const all = [
      e({ title: '本项目的坑', project: 'lakeghost', scope: '本项目' }),
      e({ title: '别的项目的坑', project: 'search', scope: '本项目' }),
      e({ title: 'GORM 通用坑', project: 'search', scope: '技术栈' }),
      e({ title: '执行机限制', project: 'search', scope: '执行环境' }),
      e({ title: '流程改进', project: 'search', scope: '流程' }),
    ];
    const got = filterByProject(all, 'lakeghost').map((x) => x.title);
    expect(got).toEqual(['本项目的坑', 'GORM 通用坑', '执行机限制', '流程改进']);
    expect(got).not.toContain('别的项目的坑'); // 不串味
  });

  it('未标项目的老条目保留（迁移期不丢历史知识）', () => {
    expect(filterByProject([e({ title: '老条目' })], 'lakeghost')).toHaveLength(1);
  });

  it('不指定项目时不过滤', () => {
    const all = [e({ project: 'a', scope: '本项目' }), e({ project: 'b', scope: '本项目' })];
    expect(filterByProject(all, undefined)).toHaveLength(2);
  });
});
