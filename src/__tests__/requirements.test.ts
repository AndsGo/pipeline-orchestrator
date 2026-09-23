import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asksToCreateReq, parseSlash } from '../commands.js';
import type { ChatRef, GateDecision } from '../ports.js';
import type { Project } from '../projects.js';
import {
  createReq,
  intakeContextOf,
  MAX_INTERVIEW_ROUNDS,
  nextReqId,
  parseBrief,
  readReq,
  remainingSplits,
  renderPool,
  type Requirement,
  roundNudge,
  saveReq,
  wipOf,
  WIP_STALE_MS,
} from '../requirements.js';
import { Semaphore } from '../semaphore.js';
import { bindReqThread, getThread, routeInThread, type ThreadRec } from '../threads.js';
import type { DaemonContext, DaemonPort } from '../daemon/context.js';

// 流程测试要隔离掉会读真实工单/多维表格的依赖
vi.mock('../bitable/reqSync.js', () => ({ projectReq: vi.fn(async () => {}) }));
vi.mock('../bitable/sync.js', async (orig) => ({ ...(await orig<typeof import('../bitable/sync.js')>()), fetchGlossaryBrief: vi.fn(async () => '') }));
const loads = vi.hoisted(() => ({ tickets: [] as string[], events: {} as Record<string, Array<{ ts: string; type: string; summary: string }>> }));
vi.mock('../events.js', async (orig) => ({
  ...(await orig<typeof import('../events.js')>()),
  listTickets: vi.fn(() => loads.tickets),
  readEvents: vi.fn((t: string) => loads.events[t] ?? []),
}));
vi.mock('../ticket.js', async (orig) => ({ ...(await orig<typeof import('../ticket.js')>()), readSnapshot: vi.fn(() => null) }));

const { afterReqTurn, confirmLoop, isClosure, onTicketClosed, pumpQueue, remindStale, scheduleLoop, startReq } = await import('../daemon/reqFlow.js');
const { DROPPED } = await import('../feishu/port.js');

const BRIEF = `好的，整理如下。

# 需求说明
标题：数据域快速查出未设权限的表
## 要解决的问题
逐张核对权限规则太慢，漏配会把核心数据开放出去
## 谁用、现在怎么做
数据管理员，按月检查
## 怎么算做好了（业务验收描述）
打开数据域就能看到哪些表没被权限规则覆盖
## 范围
含：详情页、编辑弹窗
不含：自动补权限
## 期望时间
无硬截止
## 口径已确认
- Q：草稿态规则算不算覆盖 → 答：不算（提出人选 B）
## 能力定位
扩展「数据域管理」
## 调研结论
事实：ds_permission 按 table_id 关联（backend/x.go:12）
## 假设（提出人未确认）
无
## 疑似重复
可能与 REQ-002 重叠
## 建议拆分
1. 详情页 / 弹窗提示未覆盖表
2. 数据域列表页标记有未覆盖表的域
`;

describe('parseBrief', () => {
  it('没有《需求说明》标题 → null（这一轮还在问问题）', () => {
    expect(parseBrief('Q1 你们多久检查一次？\n1. 每周 2. 每月（推荐）')).toBeNull();
  });

  it('解析标题、拆分、疑似重复、口径', () => {
    const p = parseBrief(BRIEF)!;
    expect(p.brief.startsWith('# 需求说明')).toBe(true);
    expect(p.title).toBe('数据域快速查出未设权限的表');
    expect(p.splits).toEqual(['详情页 / 弹窗提示未覆盖表', '数据域列表页标记有未覆盖表的域']);
    expect(p.dups).toEqual(['REQ-002']);
    expect(p.confirmed).toContain('草稿态规则');
  });

  it('「不拆」「无」不算拆分项；圆圈编号和短横线都认', () => {
    expect(parseBrief('# 需求说明\n标题：x\n## 建议拆分\n1. 不拆，一张单即可')!.splits).toEqual([]);
    expect(parseBrief('# 需求说明\n标题：x\n## 建议拆分\n① 甲\n- 乙')!.splits).toEqual(['甲', '乙']);
  });
});

describe('纯函数', () => {
  it('编号取最大值 +1', () => {
    expect(nextReqId([])).toBe('REQ-001');
    expect(nextReqId(['REQ-002', 'REQ-010'])).toBe('REQ-011');
  });

  it('intake 上下文把「口径已确认」改写成 ## 澄清问答（clarify 视为定论）；口径是「无」就不写', () => {
    const r = { id: 'REQ-003', brief: BRIEF, raw: 'x' } as Requirement;
    const ctx = intakeContextOf(r, '详情页 / 弹窗提示未覆盖表');
    expect(ctx).toContain('本工单负责其中一项：「详情页 / 弹窗提示未覆盖表」');
    expect(ctx).toContain('## 澄清问答（需求梳理阶段，提出人已确认）');
    expect(ctx).toContain('逐条核实');
    const none = intakeContextOf({ id: 'REQ-4', brief: '# 需求说明\n标题：x\n## 口径已确认\n无\n', raw: 'x' } as Requirement);
    expect(none).not.toContain('澄清问答');
  });

  it('在制：闭环、挂起、别的项目、7 天没动静的都不占名额', () => {
    const now = Date.now();
    const l = (ticket: string, o: Partial<{ project: string; closed: boolean; halted: boolean; age: number }> = {}) => ({
      ticket,
      project: o.project ?? 'lake',
      closed: !!o.closed,
      halted: !!o.halted,
      lastEventAt: now - (o.age ?? 0),
    });
    expect(wipOf('lake', [l('A'), l('B', { closed: true }), l('C', { halted: true }), l('D', { project: 'odoo' }), l('E', { age: WIP_STALE_MS + 1 })], now)).toEqual(['A']);
  });

  it('还没建的拆分项', () => {
    expect(remainingSplits({ splits: ['a', 'b'], tickets: ['LS-1'] } as Requirement)).toEqual(['b']);
    expect(remainingSplits({ splits: [], tickets: [] } as unknown as Requirement)).toEqual([undefined]);
    expect(remainingSplits({ tickets: ['LS-1'] } as Requirement)).toEqual([]);
  });

  it(`第 ${MAX_INTERVIEW_ROUNDS} 轮起追加「必须出说明」`, () => {
    expect(roundNudge({ id: 'REQ-1', rounds: MAX_INTERVIEW_ROUNDS - 2 } as Requirement)).toBe('');
    expect(roundNudge({ id: 'REQ-1', rounds: MAX_INTERVIEW_ROUNDS - 1 } as Requirement)).toContain('必须输出完整的《需求说明》');
  });

  it('只有真正的闭环事件算闭环（compound 的「交付文档已生成」也是 type=done）', () => {
    expect(isClosure({ type: 'done', summary: '闭环：12 次会话，$3.10' })).toBe(true);
    expect(isClosure({ type: 'done', summary: '快车道闭环' })).toBe(true);
    expect(isClosure({ type: 'done', summary: '交付文档已生成（30 块）' })).toBe(false);
  });

  it('/pool 空池给用法', () => {
    expect(renderPool([])).toContain('/req');
  });
});

describe('指令', () => {
  it('/req 与 /pool', () => {
    expect(parseSlash('/req 想一眼看出哪些表没设权限')).toEqual({ kind: 'req', text: '想一眼看出哪些表没设权限' });
    expect(parseSlash('/req')).toEqual({ kind: 'unknown', text: '/req' });
    expect(parseSlash('/pool')).toEqual({ kind: 'pool' });
  });

  it('明确要进需求池的说法', () => {
    for (const t of ['把这个整理成需求', '提个需求', '放进需求池', '记成一条需求']) expect(asksToCreateReq(t)).toBe(true);
    for (const t of ['这个需求我觉得不对', '需求原文在哪']) expect(asksToCreateReq(t)).toBe(false);
  });

  it('会话话题里猜出的 req 按续聊；明确说整理成需求才开需求；需求话题里什么都是续聊', () => {
    const runTh = { chatId: 'c', createdAt: '', lastAt: '', turns: 1, run: { sessionId: 's' } } as unknown as ThreadRec;
    expect(routeInThread({ kind: 'req', text: '服装类目不用指定模特' }, runTh, '服装类目不用指定模特', false).kind).toBe('followup');
    expect(routeInThread({ kind: 'req', text: '把这个整理成需求' }, runTh, '把这个整理成需求', false).kind).toBe('req');
    const reqTh = { chatId: 'c', createdAt: '', lastAt: '', turns: 0, req: 'REQ-001' } as ThreadRec;
    expect(routeInThread({ kind: 'req', text: '/req 再加一个' }, reqTh, '/req 再加一个', false).kind).toBe('followup');
    expect(routeInThread({ kind: 'run', text: '每月查一次' }, reqTh, '每月查一次', false).kind).toBe('followup');
  });
});

// ── 流程 ─────────────────────────────────────────────

const PROJECTS: Project[] = [{ alias: 'lake', repo: 'D:/x/lake', prefix: 'LS', chatId: 'oc_lake', owner: 'ou_owner' }];

interface Fake {
  ctx: DaemonContext;
  notify: Array<[string, string, ChatRef | undefined]>;
  gates: Array<{ ticket: string; gate: string; summary: string; allowed?: string[] }>;
  chooses: Array<{ ticket: string; options: string[]; allowed?: string[] }>;
  started: Array<[string, string, string, string | undefined]>;
  adhoc: Array<{ prompt: string; chat?: ChatRef; resume?: string }>;
  followups: string[];
}

function fakeCtx(script: { gate?: GateDecision; choose?: string; start?: (t: string) => string } = {}): Fake {
  const f: Omit<Fake, 'ctx'> = { notify: [], gates: [], chooses: [], started: [], adhoc: [], followups: [] };
  const port = {
    notify: async (t: string, m: string, chat?: ChatRef) => void f.notify.push([t, m, chat]),
    chooseOption: async (ticket: string, _q: string, options: string[], _to?: ChatRef, opts?: { allowed?: string[] }) => {
      f.chooses.push({ ticket, options, allowed: opts?.allowed });
      return script.choose ?? options[0];
    },
    confirmGate: async (ticket: string, gate: string, summary: string, _c: string[], _d?: string, opts?: { allowed?: string[] }) => {
      f.gates.push({ ticket, gate, summary, allowed: opts?.allowed });
      return script.gate ?? { approved: true };
    },
    confirmCommand: async () => true,
    sendDashboard: async () => {},
    sendStatus: async () => {},
    sendResult: async () => undefined,
    pendingLabels: () => [],
    openThread: async () => 'om_root',
    dropPending: () => 0,
  } as unknown as DaemonPort;
  const ctx: DaemonContext = {
    projects: PROJECTS.map((p) => ({ ...p })),
    cfg: { defaultProject: 'lake', maxConcurrency: 2 },
    MAIN_CHAT: 'oc_main',
    port,
    log: () => {},
    active: new Map(),
    sem: new Semaphore(2),
    adhoc: [],
    startedAt: Date.now(),
    boardOn: false,
    envFile: '',
    startTicket: async (...a) => {
      f.started.push(a as [string, string, string, string | undefined]);
      return script.start ? script.start(a[0]) : `${a[0]} 已启动`;
    },
    execAdhoc: async (_p, _cmd, prompt, _r, _c, opts) => {
      f.adhoc.push({ prompt, chat: opts?.chat, resume: opts?.resumeSessionId });
      return true;
    },
    runFollowup: async (reply) => void f.followups.push(reply),
    draftRequirementFromChat: async () => null,
  };
  return { ctx, ...f } as Fake;
}

/** 等 void 出去的卡片循环跑完 */
const settle = () => new Promise((r) => setTimeout(r, 20));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqpool-'));
  process.env.PIPELINE_DATA_DIR = dir;
  loads.tickets = [];
  loads.events = {};
});
afterEach(() => {
  delete process.env.PIPELINE_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(over: Partial<Requirement> = {}): Requirement {
  const r = createReq({ project: 'lake', requester: 'ou_req', chatId: 'oc_lake', rootId: 'om_root', raw: '想一眼看出哪些表没设权限' });
  bindReqThread('om_root', r.id, 'oc_lake', 'lake');
  return saveReq({ ...r, ...over });
}

describe('需求流程', () => {
  it('主线 /req：开话题、绑定、首轮访谈带清单进话题', async () => {
    const f = fakeCtx();
    await startReq(f.ctx, '想一眼看出哪些表没设权限', 'ou_req', 'oc_lake');
    const r = readReq('REQ-001')!;
    expect(r).toMatchObject({ status: '梳理中', project: 'lake', requester: 'ou_req', rootId: 'om_root' });
    expect(getThread('om_root')?.req).toBe('REQ-001');
    expect(f.adhoc).toHaveLength(1);
    expect(f.adhoc[0].chat).toEqual({ chatId: 'oc_lake', rootId: 'om_root' });
    expect(f.adhoc[0].prompt).toContain('要填满的槽位');
  });

  it('工单话题里 /req → 拒绝，不建需求', async () => {
    const f = fakeCtx();
    fs.writeFileSync(path.join(dir, 'threads.json'), JSON.stringify({ om_t: { chatId: 'oc_lake', ticket: 'LS-001', createdAt: '', lastAt: '', turns: 0 } }));
    await startReq(f.ctx, 'x', 'ou_req', { chatId: 'oc_lake', rootId: 'om_t' });
    expect(readReq('REQ-001')).toBeNull();
    expect(f.notify[0][1]).toContain('工单 LS-001');
  });

  it('访谈轮出了说明 → 待确认，确认卡只认提出人和负责人；通过 → 待排期，排期卡只认负责人', async () => {
    const f = fakeCtx({ choose: '搁置' });
    seed();
    await afterReqTurn(f.ctx, 'om_root', BRIEF);
    await settle();
    expect(f.gates[0]).toMatchObject({ ticket: 'REQ-001', gate: '需求确认', allowed: ['ou_req', 'ou_owner'] });
    expect(f.chooses[0]).toMatchObject({ ticket: 'REQ-001', allowed: ['ou_owner'] });
    // REQ-002 不存在 → 不给「并入」选项
    expect(f.chooses[0].options).toEqual(['排期', '搁置', '不做']);
    expect(readReq('REQ-001')).toMatchObject({ status: '搁置', title: '数据域快速查出未设权限的表', rounds: 1 });
  });

  it('没出说明的一轮只记轮次', async () => {
    const f = fakeCtx();
    seed();
    await afterReqTurn(f.ctx, 'om_root', 'Q1 多久查一次？');
    expect(readReq('REQ-001')).toMatchObject({ status: '梳理中', rounds: 1 });
    expect(f.gates).toHaveLength(0);
  });

  it('判定无需开发 → 不做', async () => {
    const f = fakeCtx();
    seed();
    await afterReqTurn(f.ctx, 'om_root', '【无需开发】导出如下……');
    expect(readReq('REQ-001')).toMatchObject({ status: '不做', note: '无需开发，已在对话中处理' });
  });

  it('提出人驳回 → 回到梳理中，意见作为下一轮续聊', async () => {
    const f = fakeCtx({ gate: { approved: false, note: '拆分不对，列表页不做' } });
    seed({ status: '待确认', brief: BRIEF });
    await confirmLoop(f.ctx, 'REQ-001');
    expect(readReq('REQ-001')?.status).toBe('梳理中');
    expect(f.followups[0]).toContain('拆分不对，列表页不做');
  });

  it('卡被作废（新版说明）→ 什么都不动', async () => {
    const f = fakeCtx({ gate: { approved: false, dropped: true } });
    seed({ status: '待确认', brief: BRIEF });
    await confirmLoop(f.ctx, 'REQ-001');
    expect(readReq('REQ-001')?.status).toBe('待确认');
    expect(f.followups).toHaveLength(0);
  });

  it('排期 → 按拆分建两张单，编号不撞，intake 带澄清问答；全部建完 → 已转工单', async () => {
    const f = fakeCtx({ choose: '排期' });
    loads.tickets = ['LS-018'];
    loads.events = { 'LS-018': [{ ts: new Date().toISOString(), type: 'done', summary: '闭环：…' }] };
    seed({ status: '待排期', brief: BRIEF, splits: parseBrief(BRIEF)!.splits });
    await scheduleLoop(f.ctx, 'REQ-001');
    expect(f.started.map((s) => s[0])).toEqual(['LS-019', 'LS-020']);
    expect(f.started[0][2]).toBe('来自需求 REQ-001：详情页 / 弹窗提示未覆盖表（需求：想一眼看出哪些表没设权限）');
    expect(f.started[0][3]).toContain('## 澄清问答');
    expect(readReq('REQ-001')).toMatchObject({ status: '已转工单', tickets: ['LS-019', 'LS-020'] });
  });

  it('在制满了 → 排队；腾出名额（闭环）后自动出队', async () => {
    const f = fakeCtx();
    const recent = new Date().toISOString();
    loads.tickets = ['LS-010', 'LS-011'];
    loads.events = { 'LS-010': [{ ts: recent, type: 'stage.start', summary: '' }], 'LS-011': [{ ts: recent, type: 'gate.asked', summary: '' }] };
    seed({ status: '已排期', scheduledAt: recent, brief: BRIEF, splits: ['只有一项'] });
    await pumpQueue(f.ctx, 'lake');
    expect(f.started).toHaveLength(0);
    expect(f.notify.at(-1)?.[1]).toContain('排队中');
    loads.events['LS-010'].push({ ts: recent, type: 'done', summary: '闭环：…' });
    await onTicketClosed(f.ctx, 'LS-010');
    expect(f.started.map((s) => s[0])).toEqual(['LS-012']);
    expect(readReq('REQ-001')?.status).toBe('已转工单');
  });

  it('关联工单闭环 → 回推提出人；全部闭环 → 已交付；闭环事件重放不重复回推', async () => {
    const f = fakeCtx();
    seed({ status: '已转工单', splits: ['a', 'b'], tickets: ['LS-019', 'LS-020'] });
    await onTicketClosed(f.ctx, 'LS-019');
    expect(readReq('REQ-001')).toMatchObject({ status: '已转工单', delivered: ['LS-019'] });
    await onTicketClosed(f.ctx, 'LS-019');
    await onTicketClosed(f.ctx, 'LS-020');
    expect(readReq('REQ-001')).toMatchObject({ status: '已交付', delivered: ['LS-019', 'LS-020'] });
    const pushes = f.notify.filter((n) => n[0] === 'REQ-001' && n[1].includes('已交付'));
    expect(pushes).toHaveLength(2);
    expect(pushes[1][1]).toContain('全部完成');
  });

  it('建单失败 → 停在已排期，说明原因', async () => {
    const f = fakeCtx({ start: (t) => `${t} 工作区分配失败：磁盘满` });
    seed({ status: '已排期', scheduledAt: new Date().toISOString(), splits: ['a'] });
    await pumpQueue(f.ctx, 'lake');
    expect(readReq('REQ-001')?.status).toBe('已排期');
    expect(f.notify.at(-1)?.[1]).toContain('建单没成功');
  });

  it('待排期超 14 天没动 → 提醒一次（重发排期卡），不重复提醒', async () => {
    const f = fakeCtx({ choose: DROPPED });
    const r = seed({ status: '待排期' });
    const later = Date.parse(r.updatedAt) + 15 * 86_400_000;
    expect(remindStale(f.ctx, later)).toEqual(['REQ-001']);
    await settle();
    expect(f.chooses).toHaveLength(1);
    expect(remindStale(f.ctx, later)).toEqual([]);
  });
});
