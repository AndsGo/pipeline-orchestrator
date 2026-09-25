import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnvReload, envKeySpec, parseEnvText } from '../envKeys.js';
import {
  buildOverview,
  docLocalPath,
  lastRestartFrom,
  listTicketDocs,
  projectsJson,
  readEnvView,
  readProjectsView,
  tailLog,
  ticketDetail,
  ticketRows,
  validateProjects,
  writeEnvChanges,
  writeProjects,
} from '../console/api.js';
import { appendEvent } from '../events.js';
import { saveTicket } from '../ticket.js';
import type { TicketState } from '../types.js';
import type { RuntimeSnapshot } from '../daemon/lifecycle.js';

/** 控制台数据层：全部落在临时目录（PIPELINE_DATA_DIR + 临时 .env），不碰真实 data/ 与 .env */
let tmp: string;
let envFile: string;
const prevDataDir = process.env.PIPELINE_DATA_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  process.env.PIPELINE_DATA_DIR = path.join(tmp, 'data');
  fs.mkdirSync(process.env.PIPELINE_DATA_DIR);
  envFile = path.join(tmp, '.env');
  fs.writeFileSync(
    envFile,
    ['# 注释', 'FEISHU_APP_SECRET=s3cret-value', 'GITLAB_URL=http://git', `PIPELINE_PROJECTS=${JSON.stringify({ demo: { repo: tmp.replace(/\\/g, '/'), prefix: 'DM' } })}`, 'MYSTERY_KEY=hidden', ''].join('\n'),
  );
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.PIPELINE_DATA_DIR;
  else process.env.PIPELINE_DATA_DIR = prevDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('envKeys', () => {
  it('parseEnvText 与 doctor 同口径：跳过注释、按第一个 = 切', () => {
    expect(parseEnvText('# a=b\nX = 1=2 \n  Y=\nbad line')).toEqual({ X: '1=2', Y: '' });
  });
  it('目录外的键按凭据对待', () => {
    expect(envKeySpec('MYSTERY_KEY').secret).toBe(true);
    expect(envKeySpec('GITLAB_URL').secret).toBeUndefined();
    expect(envKeySpec('FEISHU_APP_ID').restart).toBe('daemon');
  });
  it('applyEnvReload：热键覆盖，daemon 冻结键只记名，未变的不算', () => {
    const env: NodeJS.ProcessEnv = { GITLAB_URL: 'old', FEISHU_CHAT_ID: 'oc_old', JENKINS_URL: 'same' };
    const r = applyEnvReload({ GITLAB_URL: 'new', FEISHU_CHAT_ID: 'oc_new', JENKINS_URL: 'same', NEW_KEY: 'x' }, env);
    expect(r).toEqual({ applied: ['GITLAB_URL', 'NEW_KEY'], deferred: ['FEISHU_CHAT_ID'] });
    expect(env.GITLAB_URL).toBe('new');
    expect(env.FEISHU_CHAT_ID).toBe('oc_old');
  });
});

describe('环境配置视图与写回', () => {
  it('凭据只给长度不给值；目录外的键进「其他」组并遮蔽', () => {
    const v = readEnvView(envFile);
    const all = v.groups.flatMap((g) => g.keys);
    const secret = all.find((k) => k.key === 'FEISHU_APP_SECRET')!;
    expect(secret).toMatchObject({ set: true, length: 12, secret: true });
    expect('value' in secret).toBe(false);
    expect(all.find((k) => k.key === 'GITLAB_URL')).toMatchObject({ value: 'http://git' });
    const other = v.groups.at(-1)!;
    expect(other.name).toContain('其他');
    expect(other.keys[0]).toMatchObject({ key: 'MYSTERY_KEY', secret: true, set: true });
    expect(JSON.stringify(v)).not.toContain('hidden');
    expect(JSON.stringify(v)).not.toContain('s3cret');
  });

  it('写回：mtime 不匹配拒绝；匹配则备份进 backups/ 并只改目标行', () => {
    const { mtime } = readEnvView(envFile);
    expect(writeEnvChanges(envFile, mtime + 5000, { GITLAB_URL: 'x' })).toMatchObject({ ok: false });
    const r = writeEnvChanges(envFile, mtime, { GITLAB_URL: 'http://new', FEISHU_CHAT_ID: 'oc_1' });
    expect(r).toEqual({ ok: true, needsRestart: ['FEISHU_CHAT_ID（daemon）'] });
    const text = fs.readFileSync(envFile, 'utf-8');
    expect(text).toContain('# 注释');
    expect(text).toContain('GITLAB_URL=http://new');
    expect(text).toContain('FEISHU_APP_SECRET=s3cret-value');
    expect(text).toContain('FEISHU_CHAT_ID=oc_1');
    const backups = fs.readdirSync(path.join(tmp, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^env-.*\.bak$/);
    // 仓库根不许出现 .env.bak-*
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('.env.'))).toEqual([]);
  });

  it('值含换行拒绝（一行一变量）', () => {
    const { mtime } = readEnvView(envFile);
    expect(writeEnvChanges(envFile, mtime, { GITLAB_URL: 'a\nB=1' })).toMatchObject({ ok: false });
  });
});

describe('项目配置', () => {
  it('从 .env 文件读项目表，不看进程环境', () => {
    process.env.PIPELINE_PROJECTS = JSON.stringify({ other: { repo: '/x', prefix: 'OT' } });
    try {
      expect(readProjectsView(envFile).projects.map((p) => p.alias)).toEqual(['demo']);
    } finally {
      delete process.env.PIPELINE_PROJECTS;
    }
  });
  it('整表校验：别名/前缀互斥、路径存在、open_id 形状', () => {
    const errs = validateProjects(
      [
        { alias: 'a', repo: '/r', prefix: 'AA', owner: 'bad' },
        { alias: 'A', repo: '', prefix: 'aa' },
        { alias: '1x', repo: '/missing', prefix: 'TOOLONGX' },
      ],
      (p) => p === '/r',
    );
    expect(errs.join('\n')).toMatch(/别名「A」重复/);
    expect(errs.join('\n')).toMatch(/前缀「aa」与项目 a 冲突/);
    expect(errs.join('\n')).toMatch(/仓库路径不能为空/);
    expect(errs.join('\n')).toMatch(/负责人应是 open_id/);
    expect(errs.join('\n')).toMatch(/别名「1x」不合法/);
    expect(errs.join('\n')).toMatch(/仓库路径不存在 \/missing/);
    expect(validateProjects([], () => true)).toEqual(['至少要有一个项目']);
  });
  it('序列化：空字段不写、路径正斜杠、前缀大写；写回走同一条 .env 路径', () => {
    expect(JSON.parse(projectsJson([{ alias: 'a', repo: 'D:\\w\\r', prefix: 'aa', gitlab: ' g/p ', owner: '' }]))).toEqual({ a: { repo: 'D:/w/r', prefix: 'AA', gitlab: 'g/p' } });
    const { mtime } = readProjectsView(envFile);
    const r = writeProjects(envFile, mtime, [{ alias: 'demo', repo: tmp, prefix: 'DM', owner: 'ou_abc123' }]);
    expect(r).toEqual({ ok: true, needsRestart: [] });
    expect(readProjectsView(envFile).projects[0]).toMatchObject({ alias: 'demo', owner: 'ou_abc123', prefix: 'DM' });
  });
});

const snap = (ticket: string, extra: Partial<TicketState> = {}): TicketState => ({
  ticket,
  repo: tmp,
  cursor: 'plan',
  reviewFixRounds: 0,
  acceptanceFixRounds: 0,
  pendingReverify: null,
  project: 'demo',
  runs: [{ stage: 'clarify', extraArgs: '', startedAt: '2026-09-25T00:00:00Z', costUsd: 1.5, turns: 10, status: 'DONE', sessionId: 's' }],
  ...extra,
});
const rt = (extra: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  pid: 1,
  startedAt: Date.now() - 60_000,
  at: Date.now(),
  concurrency: { inUse: 1, max: 2, waiting: 0 },
  active: ['DM-001'],
  pending: {},
  adhoc: { count: 0, cost: 0 },
  boardOn: false,
  projects: ['demo'],
  ...extra,
});

describe('任务视图', () => {
  it('行状态：在跑来自心跳、挂起来自快照、闭环看 compound、待答来自心跳分组', () => {
    saveTicket(snap('DM-001'));
    saveTicket(snap('DM-002', { haltedReason: '预算超限' }));
    saveTicket(snap('DM-003', { runs: [{ stage: 'compound', extraArgs: '', startedAt: 'x', costUsd: 0.2, turns: 1, status: 'DONE', sessionId: 's' }] }));
    saveTicket(snap('DM-004'));
    appendEvent({ ticket: 'DM-001', type: 'stage.end', stage: 'clarify', summary: 'clarify 完成', payload: { costUsd: 2 } });
    const rows = ticketRows(rt({ pending: { 'DM-004': ['PRD 确认'] } }));
    const by = Object.fromEntries(rows.map((r) => [r.ticket, r]));
    expect(by['DM-001']).toMatchObject({ state: '在跑', cost: 2, waiting: 'clarify 完成', stage: 'plan' });
    expect(by['DM-002']).toMatchObject({ state: '挂起', waiting: '挂起：预算超限', cost: 1.5 });
    expect(by['DM-003']).toMatchObject({ state: '闭环', stage: '已闭环' });
    expect(by['DM-004']).toMatchObject({ state: '等人工', waiting: '等回答：PRD 确认' });
  });
  it('详情带事件、暂停态与文档清单；无此工单返回 null', () => {
    saveTicket(snap('DM-001'));
    fs.mkdirSync(path.join(tmp, 'docs', 'pipeline', 'DM-001', 'prototype'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'pipeline', 'DM-001', '10-prd.md'), '# PRD');
    fs.writeFileSync(path.join(tmp, 'docs', 'pipeline', 'DM-001', 'prototype', 'index.html'), '<p>');
    fs.writeFileSync(path.join(tmp, 'docs', 'pipeline', 'DM-001', 'notes.exe'), '');
    const d = ticketDetail('DM-001', rt())!;
    expect(d.running).toBe(true);
    expect(d.docs).toEqual(['10-prd.md', 'prototype/index.html']);
    expect(ticketDetail('DM-999', null)).toBeNull();
  });
  it('总览：心跳新鲜即在线，今日成本只算今天的 stage.end', () => {
    saveTicket(snap('DM-001'));
    appendEvent({ ticket: 'DM-001', type: 'stage.end', stage: 'clarify', summary: 'x', payload: { costUsd: 3 } });
    fs.writeFileSync(path.join(process.env.PIPELINE_DATA_DIR!, 'runtime.json'), JSON.stringify(rt()));
    const wd = path.join(tmp, 'watchdog.log');
    fs.writeFileSync(wd, ['2026-09-20T10:00:00 skip restart (x)', '2026-09-20T10:05:00 RESTART (dead)', '2026-09-20T10:07:00 backup ok'].join('\n'));
    const o = buildOverview({ dir: process.env.PIPELINE_DATA_DIR!, watchdogLog: wd, now: Date.now() });
    expect(o.daemon.alive).toBe(true);
    expect(o.tickets).toMatchObject({ total: 1, running: 1 });
    expect(o.lastRestart?.at).toBe('2026-09-20T10:05:00');
    expect(o.stopPending).toBe(false);
    expect(o.todayCost).toBe(3);
    // 「今日」以 now 所在的本地日期为准：把 now 挪到别的日子，刚写的事件就不算
    expect(buildOverview({ dir: process.env.PIPELINE_DATA_DIR!, watchdogLog: wd, now: Date.parse('2026-09-20T12:00:00') }).todayCost).toBe(0);
  });
  it('lastRestartFrom 大小写敏感：skip 行的小写 restart 不算', () => {
    const wd = path.join(tmp, 'w.log');
    fs.writeFileSync(wd, '2026-09-25T10:00:00 skip restart (x)\n');
    expect(lastRestartFrom(wd)).toBeNull();
  });
});

describe('文档路径防线', () => {
  it('锁在 docs/pipeline 内，拒绝穿越、反斜杠与白名单外扩展名', () => {
    const base = path.resolve(tmp, 'docs', 'pipeline');
    expect(docLocalPath(tmp, 'DM-001/10-prd.md')).toBe(path.join(base, 'DM-001', '10-prd.md'));
    expect(docLocalPath(tmp, 'PROJECT-BRIEF.md')).toBe(path.join(base, 'PROJECT-BRIEF.md'));
    expect(docLocalPath(tmp, '../.env')).toBeNull();
    expect(docLocalPath(tmp, 'DM-001/../../.env')).toBeNull();
    expect(docLocalPath(tmp, 'DM-001\\10-prd.md')).toBeNull();
    expect(docLocalPath(tmp, 'DM-001/run.exe')).toBeNull();
    expect(docLocalPath(tmp, '')).toBeNull();
  });
  it('listTicketDocs 无目录返回空', () => {
    expect(listTicketDocs(tmp, 'DM-404')).toEqual([]);
  });
});

describe('日志尾巴', () => {
  it('按正则过滤、只取尾部、给总行数', () => {
    const f = path.join(tmp, 'd.log');
    fs.writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line ${i} ${i % 10 === 0 ? 'ERROR' : 'ok'}`).join('\n'));
    expect(tailLog(f, 3)).toEqual({ lines: ['line 47 ok', 'line 48 ok', 'line 49 ok'], total: 50 });
    expect(tailLog(f, 100, 'error').lines).toHaveLength(5);
    expect(tailLog(f, 100, '[').lines).toEqual([]); // 坏正则退化为子串匹配
    expect(tailLog(path.join(tmp, 'none.log'), 10)).toEqual({ lines: [], total: 0 });
  });
});
