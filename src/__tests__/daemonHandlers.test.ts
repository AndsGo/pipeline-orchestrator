import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRef, GateDecision } from '../ports.js';
import type { Project } from '../projects.js';
import { Semaphore } from '../semaphore.js';
import type { TicketState } from '../types.js';
import type { DaemonContext, DaemonPort } from '../daemon/context.js';
import { handlers } from '../daemon/handlers/index.js';
import { appendEvent, listTickets } from '../events.js';
import { readLastRun, readLastRunFor, type LastRun } from '../followup.js';
import { clearPaused } from '../pause.js';
import { peekTicketRepo, readSnapshot, saveTicket } from '../ticket.js';

/**
 * 处理器单测：daemon.ts 在 import 时就读配置、连飞书，所以只能测拆出来的处理器。
 * 会落盘到 data/ 的模块一律替换掉——测试不许碰真实工单数据；粘性用内存表代替文件。
 */
vi.mock('../ticket.js', async (orig) => ({
  ...(await orig<typeof import('../ticket.js')>()),
  readSnapshot: vi.fn(() => null),
  saveTicket: vi.fn(),
  peekTicketRepo: vi.fn(() => null),
}));
vi.mock('../events.js', async (orig) => ({
  ...(await orig<typeof import('../events.js')>()),
  appendEvent: vi.fn(),
  listTickets: vi.fn(() => []),
}));
vi.mock('../pause.js', () => ({ clearPaused: vi.fn(), setPaused: vi.fn() }));
vi.mock('../followup.js', async (orig) => ({
  ...(await orig<typeof import('../followup.js')>()),
  readLastRun: vi.fn(() => null),
  readLastRunFor: vi.fn(() => null),
}));
vi.mock('../sticky.js', async (orig) => {
  const m = await orig<typeof import('../sticky.js')>();
  const mem = new Map<string, string>();
  return {
    ...m,
    readSticky: (chat: string, projects: Project[]) => projects.find((p) => p.alias === mem.get(chat)) ?? null,
    writeSticky: (chat: string, alias: string) => void mem.set(chat, alias),
  };
});
// amend/rewind 才用到；隔离掉整棵 ticketRunner 依赖树（它在另一处并行重构）
vi.mock('../ticketRunner.js', () => ({ scheduleRewind: vi.fn(), runTicket: vi.fn() }));

const PROJECTS: Project[] = [
  { alias: 'lakeghost', repo: 'D:/x/lake_spirit', prefix: 'LS', chatId: 'oc_lake' },
  { alias: 'nova', repo: 'D:/x/nova', prefix: 'NV' },
];

interface Script {
  choose?: string[];
  gate?: GateDecision;
}

function fakeCtx(script: Script = {}, over: Partial<DaemonContext> = {}) {
  const notify: Array<[string, string, ChatRef | undefined]> = [];
  const choose: Array<{ ticket: string; question: string; options: string[]; chat?: ChatRef }> = [];
  const gates: Array<{ ticket: string; gate: string; summary: string }> = [];
  const started: unknown[][] = [];
  const followups: Array<[string, ChatRef | undefined]> = [];
  const logs: string[] = [];
  const port: DaemonPort = {
    notify: async (t, m, chat) => void notify.push([t, m, chat]),
    chooseOption: async (ticket, question, options, chat) => {
      choose.push({ ticket, question, options, chat });
      return script.choose?.shift() ?? options[0];
    },
    confirmGate: async (ticket, gate, summary) => {
      gates.push({ ticket, gate, summary });
      return script.gate ?? { approved: true };
    },
    confirmCommand: async () => true,
    sendDashboard: async () => {},
    sendStatus: async () => {},
    sendResult: async () => undefined,
    pendingLabels: () => [],
  };
  const ctx: DaemonContext = {
    projects: PROJECTS.map((p) => ({ ...p })),
    cfg: { defaultProject: 'lakeghost', maxConcurrency: 2 },
    MAIN_CHAT: 'oc_main',
    port,
    log: (m) => void logs.push(m),
    active: new Map(),
    sem: new Semaphore(2),
    adhoc: [],
    startedAt: Date.now(),
    boardOn: false,
    envFile: '',
    startTicket: async (...a) => {
      started.push(a);
      return `${a[0]} 已启动`;
    },
    execAdhoc: async () => true,
    runFollowup: async (reply, chat) => void followups.push([reply, chat]),
    draftRequirementFromChat: async () => null,
    ...over,
  };
  return { ctx, notify, choose, gates, started, followups, logs };
}

function lastRun(over: Partial<LastRun> = {}): LastRun {
  return { at: new Date().toISOString(), project: 'lakeghost', command: '查一下鉴权中间件', output: '在 src/auth.ts。\n1. 要不要加限流？', chain: 0, ...over };
}

beforeEach(() => {
  vi.mocked(readLastRun).mockReturnValue(null);
  vi.mocked(readLastRunFor).mockReturnValue(null);
  vi.mocked(readSnapshot).mockReturnValue(null);
  vi.mocked(peekTicketRepo).mockReturnValue(null);
  vi.mocked(listTickets).mockReturnValue([]);
  vi.mocked(saveTicket).mockClear();
  vi.mocked(appendEvent).mockClear();
  vi.mocked(clearPaused).mockClear();
});

describe('new', () => {
  it('空 /new 且没有可用的 /run 记录 → 给出用法引导，不建单', async () => {
    const { ctx, notify, started } = fakeCtx();
    await handlers.new(ctx, { kind: 'new', requirement: '' }, 'alice', 'oc_free');
    expect(started).toEqual([]);
    expect(notify).toEqual([['新工单', expect.stringContaining('「/new」后面要跟需求原文'), 'oc_free']]);
  });

  it('最近的 /run 属于另一项目、而本群绑定了别的项目 → 明说、拒绝，不建单', async () => {
    vi.mocked(readLastRun).mockReturnValue(lastRun({ project: 'nova' }));
    const { ctx, notify, started } = fakeCtx();
    await handlers.new(ctx, { kind: 'new', requirement: '按刚才聊的建单' }, 'alice', 'oc_lake');
    expect(started).toEqual([]);
    expect(notify).toHaveLength(1);
    expect(notify[0][1]).toContain('是在项目 nova 上，本群绑定的是 lakeghost');
  });

  it('草拟路径：对话整理成需求 → 确认卡通过（带备注）→ 备注并入需求建单', async () => {
    vi.mocked(readLastRun).mockReturnValue(lastRun());
    const { ctx, gates, started } = fakeCtx(
      { gate: { approved: true, note: '限流阈值 100/min' } },
      { draftRequirementFromChat: async () => '给 /mcp 端点加限流' },
    );
    await handlers.new(ctx, { kind: 'new', requirement: '' }, 'alice', 'oc_free');
    expect(gates).toEqual([expect.objectContaining({ ticket: 'LS-001', gate: '建单确认' })]);
    expect(started).toHaveLength(1);
    const [ticket, alias, requirement, context] = started[0] as [string, string, string, string | undefined];
    expect([ticket, alias]).toEqual(['LS-001', 'lakeghost']);
    expect(requirement).toBe('给 /mcp 端点加限流\n\n用户在确认建单时补充：限流阈值 100/min');
    expect(context).toContain('以下是建单前最近一次单次执行');
  });

  it('草拟路径被驳回 → 取消，不建单', async () => {
    vi.mocked(readLastRun).mockReturnValue(lastRun());
    const { ctx, notify, started } = fakeCtx({ gate: { approved: false, note: '还没聊完' } }, { draftRequirementFromChat: async () => '草稿' });
    await handlers.new(ctx, { kind: 'new', requirement: '' }, 'alice', 'oc_free');
    expect(started).toEqual([]);
    expect(notify.at(-1)?.[1]).toBe('已取消建单（还没聊完）');
  });

  it('正常需求：工单号前缀定项目，同项目的 /run 记录作为 intake 上下文一并交给 startTicket', async () => {
    vi.mocked(readLastRun).mockReturnValue(lastRun());
    const { ctx, notify, started } = fakeCtx();
    await handlers.new(ctx, { kind: 'new', ticket: 'LS-009', requirement: '给 /mcp 端点加限流' }, 'alice');
    expect(started).toHaveLength(1);
    const [ticket, alias, requirement, context] = started[0] as [string, string, string, string | undefined];
    expect([ticket, alias, requirement]).toEqual(['LS-009', 'lakeghost', '给 /mcp 端点加限流']);
    expect(context).toContain('以下是建单前最近一次单次执行');
    expect(notify.map((n) => n[1])).toEqual(['LS-009 已启动', expect.stringContaining('已自动附带建单前的 /run 对话记录')]);
  });

  it('/run 记录属于别的项目 → 不附带上下文，也不发「已自动附带」', async () => {
    vi.mocked(readLastRun).mockReturnValue(lastRun({ project: 'nova' }));
    const { ctx, notify, started } = fakeCtx();
    await handlers.new(ctx, { kind: 'new', ticket: 'LS-009', requirement: '给 /mcp 端点加限流' }, 'alice');
    expect((started[0] as unknown[])[3]).toBeUndefined();
    expect(notify).toHaveLength(1);
  });
});

describe('bind', () => {
  let dir: string;
  let envFile: string;
  const savedEnv = process.env.PIPELINE_PROJECTS;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-bind-'));
    envFile = path.join(dir, '.env');
    const json = JSON.stringify({ lakeghost: { repo: 'D:/x/lake_spirit', prefix: 'LS', chatId: 'oc_lake' }, nova: { repo: 'D:/x/nova', prefix: 'NV' } });
    fs.writeFileSync(envFile, `FEISHU_APP_ID=cli_x\nPIPELINE_PROJECTS=${json}\n`, 'utf-8');
    process.env.PIPELINE_PROJECTS = json;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.PIPELINE_PROJECTS;
    else process.env.PIPELINE_PROJECTS = savedEnv;
  });

  it('主群拒绝绑定：综合入口不归任何单一项目', async () => {
    const { ctx, notify } = fakeCtx({}, { envFile });
    await handlers.bind(ctx, { kind: 'bind', alias: 'nova' }, 'alice', 'oc_main');
    expect(notify).toEqual([['项目', expect.stringContaining('主群保持综合入口'), 'oc_main']]);
    expect(fs.readFileSync(envFile, 'utf-8')).toContain('"chatId":"oc_lake"'); // 未改
  });

  it('一群一项目：在已绑 lakeghost 的群里 /bind nova → 解除旧绑定、写 .env、热加载、留备份', async () => {
    const { ctx, notify, logs } = fakeCtx({}, { envFile });
    await handlers.bind(ctx, { kind: 'bind', alias: 'nova' }, 'alice', 'oc_lake');
    const env = fs.readFileSync(envFile, 'utf-8');
    expect(env.startsWith('FEISHU_APP_ID=cli_x\n')).toBe(true); // 其他行原样
    const written = JSON.parse(/^PIPELINE_PROJECTS=(.*)$/m.exec(env)![1]) as Record<string, { chatId?: string }>;
    expect(written.nova.chatId).toBe('oc_lake');
    expect(written.lakeghost.chatId).toBeUndefined();
    // 内存表原地热加载：引用不变，内容已换
    expect(ctx.projects.find((p) => p.alias === 'nova')?.chatId).toBe('oc_lake');
    expect(ctx.projects.find((p) => p.alias === 'lakeghost')?.chatId).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
    expect(logs.at(-1)).toContain('绑定项目 nova（解除原绑定 lakeghost）');
    expect(notify[0][1]).toContain('已解除本群与 lakeghost 的原绑定');
  });

  it('别名不存在 → 列出可用项目，不动 .env', async () => {
    const { ctx, notify } = fakeCtx({}, { envFile });
    await handlers.bind(ctx, { kind: 'bind', alias: 'navo' }, 'alice', 'oc_free');
    expect(notify[0][1]).toContain('没有叫「navo」的项目');
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });
});

describe('use', () => {
  it('绑定群无需 /use', async () => {
    const { ctx, notify } = fakeCtx();
    await handlers.use(ctx, { kind: 'use', alias: 'nova' }, 'alice', 'oc_lake');
    expect(notify[0][1]).toContain('本群已绑定 **lakeghost**');
  });

  it('不带别名且无粘性 → 说明当前默认项目', async () => {
    const { ctx, notify } = fakeCtx();
    await handlers.use(ctx, { kind: 'use' }, 'alice', 'oc_use_1');
    expect(notify[0][1]).toContain('消息默认归 **lakeghost**');
  });

  it('/use nova → 记粘性；随后不带别名的 /use 能读回来', async () => {
    const { ctx, notify } = fakeCtx();
    await handlers.use(ctx, { kind: 'use', alias: 'nova' }, 'alice', 'oc_use_2');
    expect(notify[0][1]).toContain('默认按 **nova** 处理');
    await handlers.use(ctx, { kind: 'use' }, 'alice', 'oc_use_2');
    expect(notify[1][1]).toContain('本群当前上下文：**nova**');
  });

  it('拼错的别名（navo）按模糊匹配认成 nova；完全对不上则列出可用项目', async () => {
    const { ctx, notify } = fakeCtx();
    await handlers.use(ctx, { kind: 'use', alias: 'navo' }, 'alice', 'oc_use_3');
    expect(notify[0][1]).toContain('默认按 **nova** 处理');
    await handlers.use(ctx, { kind: 'use', alias: 'zzz' }, 'alice', 'oc_use_3');
    expect(notify[1][1]).toContain('没有叫「zzz」的项目');
  });
});

describe('resume', () => {
  it('清暂停标记与挂起原因、记事件、按已绑定仓库续跑', async () => {
    vi.mocked(readSnapshot).mockReturnValue({ ticket: 'LS-003', repo: 'D:/x/lake_spirit', cursor: 'review', haltedReason: 'CI 失败', runs: [] } as unknown as TicketState);
    vi.mocked(peekTicketRepo).mockReturnValue('D:/x/lake_spirit');
    const { ctx, notify, started } = fakeCtx();
    await handlers.resume(ctx, { kind: 'resume', ticket: 'LS-003' }, 'alice');
    expect(clearPaused).toHaveBeenCalledWith('LS-003');
    expect(saveTicket).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveTicket).mock.calls[0][0]).toMatchObject({ ticket: 'LS-003', haltedReason: undefined });
    expect(appendEvent).toHaveBeenCalledWith({ ticket: 'LS-003', type: 'resume', summary: '收到继续指令（by alice）' });
    expect(started).toEqual([['LS-003', 'D:/x/lake_spirit']]);
    expect(notify).toEqual([['LS-003', 'LS-003 已启动', undefined]]);
  });

  it('未挂起的工单不重写快照', async () => {
    vi.mocked(readSnapshot).mockReturnValue({ ticket: 'LS-004', runs: [] } as unknown as TicketState);
    const { ctx, started } = fakeCtx();
    await handlers.resume(ctx, { kind: 'resume', ticket: 'LS-004' }, 'alice');
    expect(saveTicket).not.toHaveBeenCalled();
    expect(started).toEqual([['LS-004', undefined]]);
  });
});

describe('unknown', () => {
  it('斜杠命令拼错 → 给最接近的候选（/dashborad 实测）', async () => {
    vi.mocked(readLastRunFor).mockReturnValue(lastRun()); // 有记录也不该当续聊：斜杠开头是命令打错，不是回话
    const { ctx, notify, choose } = fakeCtx();
    await handlers.unknown(ctx, { kind: 'unknown', text: '/dashborad' }, 'alice', 'oc_free');
    expect(notify).toEqual([['指令', '没有 `/dashborad`，你是不是想说 `/dashboard`？', 'oc_free']]);
    expect(choose).toEqual([]);
  });

  it('非斜杠、无 /run 记录 → 「没听懂」+ 帮助', async () => {
    const { ctx, notify } = fakeCtx();
    await handlers.unknown(ctx, { kind: 'unknown', text: '嗯嗯好的' }, 'alice', 'oc_free');
    expect(notify[0][1]).toMatch(/^没听懂「嗯嗯好的」。\n/);
    expect(notify[0][1]).toContain('/new LS-004');
  });

  it('非斜杠、有 /run 记录 → 先问是否在回复上次执行；选「是」走续聊', async () => {
    vi.mocked(readLastRunFor).mockReturnValue(lastRun());
    const { ctx, followups, choose } = fakeCtx({ choose: ['是，接着办'] });
    await handlers.unknown(ctx, { kind: 'unknown', text: '1 要，阈值 100' }, 'alice', 'oc_free');
    expect(choose[0].question).toContain('你是不是在回复刚才的执行结果');
    expect(followups).toEqual([['1 要，阈值 100', 'oc_free']]);
  });

  it('选「不是」→ 忽略这句', async () => {
    vi.mocked(readLastRunFor).mockReturnValue(lastRun());
    const { ctx, followups, notify } = fakeCtx({ choose: ['不是，忽略这句'] });
    await handlers.unknown(ctx, { kind: 'unknown', text: '随便一句' }, 'alice', 'oc_free');
    expect(followups).toEqual([]);
    expect(notify[0][1]).toContain('这句已忽略');
  });
});
