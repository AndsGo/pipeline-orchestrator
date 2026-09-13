import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from '../commands.js';
import type { LastRun } from '../followup.js';
import { chatIdOf, rootIdOf } from '../ports.js';
import {
  BRIEF_ROUNDS,
  bindTicketThread,
  compactRounds,
  expiredSessionBrief,
  getThread,
  HINT_INTERVAL_MS,
  looksLikeInstruction,
  markPendingHint,
  pushPending,
  readThreads,
  rememberThreadRun,
  renderPending,
  routeInThread,
  sessionFresh,
  switchThreadProject,
  takePending,
  THREAD_SESSION_MAX_TURNS,
  type ThreadRec,
  threadOfTicket,
} from '../threads.js';

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'threads-')), 'threads.json');
const run = (over: Partial<LastRun> = {}): LastRun => ({
  at: '2026-09-10T01:00:00.000Z',
  project: 'lakeghost',
  command: '看看登录为什么慢',
  output: 'x'.repeat(10_000),
  chain: 0,
  sessionId: 'sess-1',
  ...over,
});
const NOW = Date.parse('2026-09-10T02:00:00.000Z');

describe('threads：话题 = 会话（设计稿 2026-09-09-thread-context）', () => {
  it('工单话题：绑定后按 rootId 与按工单都能找到；重复绑定保留 createdAt', () => {
    const f = tmp();
    bindTicketThread('om_root1', 'LS-018', 'oc_lake', 'lakeghost', f, NOW);
    expect(getThread('om_root1', f)?.ticket).toBe('LS-018');
    expect(threadOfTicket('LS-018', f)?.rootId).toBe('om_root1');
    expect(threadOfTicket('LS-999', f)).toBeNull();
    bindTicketThread('om_root1', 'LS-018', 'oc_lake', 'lakeghost', f, NOW + 60_000);
    expect(getThread('om_root1', f)?.createdAt).toBe(new Date(NOW).toISOString());
    expect(getThread(undefined, f)).toBeNull();
  });

  it('会话话题：记会话、轮次累计，同会话 +1，换会话归 1；输出截断、transcript 只落压缩版', () => {
    const f = tmp();
    rememberThreadRun('om_r', 'oc_lake', run(), f, NOW);
    const rounds = Array.from({ length: 15 }, (_, i) => ({ command: `第${i + 1}句`, output: 'y'.repeat(2000) }));
    rememberThreadRun('om_r', 'oc_lake', run({ chain: 1, transcript: rounds }), f, NOW + 1000);
    const rec = getThread('om_r', f)!;
    expect(rec.turns).toBe(2);
    expect(rec.run?.output.length).toBe(8000);
    expect(rec.run?.transcript?.length).toBe(BRIEF_ROUNDS);
    expect(rec.run?.transcript?.[0].command).toBe('第4句');
    expect(rec.run?.transcript?.[0].output.length).toBe(400);
    rememberThreadRun('om_r', 'oc_lake', run({ sessionId: 'sess-2' }), f, NOW + 2000);
    expect(getThread('om_r', f)?.turns).toBe(1);
  });

  it('会话寿命：30 轮或 7 天不活跃即到期；到期摘要带原任务与最近各轮过程（含结尾的「用到的工具」行）', () => {
    const base: ThreadRec = { chatId: 'oc', run: run(), createdAt: 'x', lastAt: new Date(NOW).toISOString(), turns: 3 };
    expect(sessionFresh(base, NOW + 1000)).toBe(true);
    expect(sessionFresh({ ...base, turns: THREAD_SESSION_MAX_TURNS }, NOW + 1000)).toBe(false);
    expect(sessionFresh(base, NOW + 7 * 24 * 3600_000 + 1)).toBe(false);
    // 没有 transcript 的旧记录：退回单轮，输出只留头 400 字
    const single = expiredSessionBrief(base)!;
    expect(single).toContain('看看登录为什么慢');
    expect(single.length).toBeLessThan(400 + 400);
    // 2026-09-12 真机：第 29 轮用内网接口生了 282 张图，接口写在输出很后面；重开的会话必须还能看到它
    const gen = `282 条全部完成。${'z'.repeat(3000)}\n\n**用到的工具：** POST http://10.0.20.39:8800/edit（JSON {prompt, images:[base64]}）`;
    const rounds = [
      { command: '把表里的提示词跑一遍', output: gen },
      { command: '为什么还是有灯', output: '分析如下……' },
    ];
    const brief = expiredSessionBrief({ ...base, run: run({ transcript: rounds }) })!;
    expect(brief).toContain('[1/2] 用户：把表里的提示词跑一遍');
    expect(brief).toContain('用到的工具：** POST http://10.0.20.39:8800/edit');
    expect(brief).toContain('[2/2] 用户：为什么还是有灯');
    expect(brief).not.toContain('z'.repeat(500));
    expect(compactRounds(rounds)[0].output.length).toBeLessThan(400 + 120);
    expect(expiredSessionBrief({ ...base, run: undefined })).toBeNull();
  });

  it('修剪：超 60 天不活跃的记录被清掉；坏文件当空表', () => {
    const f = tmp();
    bindTicketThread('om_old', 'LS-1', 'oc', undefined, f, NOW - 61 * 24 * 3600_000);
    bindTicketThread('om_new', 'LS-2', 'oc', undefined, f, NOW);
    expect(Object.keys(readThreads(f))).toEqual(['om_new']);
    fs.writeFileSync(f, 'not-json');
    expect(readThreads(f)).toEqual({});
  });

  describe('routeInThread（§3.4 判定顺序）', () => {
    const ticketTh: ThreadRec = { chatId: 'oc', ticket: 'LS-018', createdAt: 'x', lastAt: 'y', turns: 0 };
    const runTh: ThreadRec = { chatId: 'oc', run: run(), createdAt: 'x', lastAt: 'y', turns: 1 };

    it('工单话题：缺工单号的 status/answer 补上；续聊/没听懂 → 这张单的说明；指名别的单照旧', () => {
      expect(routeInThread({ kind: 'status' }, ticketTh, '到哪了', false)).toEqual({ kind: 'status', ticket: 'LS-018' });
      expect(routeInThread({ kind: 'followup', text: '这些人工号重了' }, ticketTh, '', false)).toEqual({ kind: 'note', ticket: 'LS-018', text: '这些人工号重了' });
      expect(routeInThread({ kind: 'unknown', text: '嗯' }, ticketTh, '', false)).toEqual({ kind: 'note', ticket: 'LS-018', text: '嗯' });
      const other: Command = { kind: 'note', ticket: 'LS-016', text: 't' };
      expect(routeInThread(other, ticketTh, '', false)).toBe(other);
      const runCmd: Command = { kind: 'run', text: '跑下测试' };
      expect(routeInThread(runCmd, ticketTh, '', false)).toBe(runCmd);
    });

    it('会话话题 / 话题根是结果卡：续聊、新问、没听懂都续会话，/re 前缀剥掉', () => {
      expect(routeInThread({ kind: 'run', text: '再看看 B 方案' }, runTh, '再看看 B 方案', false)).toEqual({ kind: 'followup', text: '再看看 B 方案' });
      expect(routeInThread({ kind: 'unknown', text: '/re 1' }, null, '/re 1', true)).toEqual({ kind: 'followup', text: '1' });
      expect(routeInThread({ kind: 'run', text: '再看 B' }, runTh, '/run 再看 B', false)).toEqual({ kind: 'followup', text: '再看 B' });
      // 分类器标了对外副作用：run 变 followup 不能把确认闸门变没
      expect(routeInThread({ kind: 'run', text: '推一下', sideEffect: true }, runTh, '推一下', false)).toEqual({ kind: 'followup', text: '推一下', sideEffect: true });
      const status: Command = { kind: 'status', ticket: 'LS-1' };
      expect(routeInThread(status, runTh, '', false)).toBe(status);
    });

    it('没绑任何东西：原样返回（同一引用）', () => {
      const c: Command = { kind: 'run', text: 'x' };
      expect(routeInThread(c, null, 'x', false)).toBe(c);
    });
  });

  it('ChatRef 助手：字符串只有群；Origin 拆出群与话题根', () => {
    expect(chatIdOf('oc_x')).toBe('oc_x');
    expect(rootIdOf('oc_x')).toBeUndefined();
    expect(chatIdOf({ chatId: 'oc_x', rootId: 'om_r' })).toBe('oc_x');
    expect(rootIdOf({ chatId: 'oc_x', rootId: 'om_r' })).toBe('om_r');
    expect(chatIdOf(undefined)).toBeUndefined();
  });
});

describe('routeInThread：会话话题里的 new（2026-09-11 真机）', () => {
  const runTh: ThreadRec = { chatId: 'oc', run: { at: 'x', project: 'p', command: 'c', output: 'o', chain: 0 }, createdAt: 'x', lastAt: 'y', turns: 1 };
  it('分类器猜的 new → 续聊；明确要建单或亲手 /new → 仍建单', () => {
    const guessed: Command = { kind: 'new', requirement: '服装的类目不需要指定模特穿衣服，更换背景就行' };
    expect(routeInThread(guessed, runTh, '服装的类目不需要指定模特穿衣服，更换背景就行', false)).toEqual({ kind: 'followup', text: '服装的类目不需要指定模特穿衣服，更换背景就行' });
    const explicit: Command = { kind: 'new', requirement: '按刚才聊的建单' };
    expect(routeInThread(explicit, runTh, '按刚才聊的建单', false)).toBe(explicit);
    const slash: Command = { kind: 'new', requirement: '把结论建成工单' };
    expect(routeInThread(slash, runTh, '/new 把结论建成工单', false)).toBe(slash);
  });
});

describe('攒下的「像指令」的话加 👀（2026-09-12 真机：「可以的，执行吧」「C000052单独重新跑一遍」没 @，人干等 9～22 分钟）', () => {
  it('词面判定：动词开头或「吧/一下/一遍」收尾算指令；问句、讨论不算', () => {
    expect(looksLikeInstruction('可以的，执行吧')).toBe(true);
    expect(looksLikeInstruction('C000052单独重新跑一遍')).toBe(true);
    expect(looksLikeInstruction('帮我把这页导出来')).toBe(true);
    expect(looksLikeInstruction('我觉得这个背景不太对')).toBe(false);
    expect(looksLikeInstruction('为什么还是会出现这个灯？')).toBe(false);
    expect(looksLikeInstruction('这个能改吗?')).toBe(false);
  });
  it('每话题每小时最多提示一次；未绑定的话题不提示', () => {
    const f = tmp();
    rememberThreadRun('om_h', 'oc', run(), f, NOW);
    expect(markPendingHint('om_h', f, NOW)).toBe(true);
    expect(markPendingHint('om_h', f, NOW + 10 * 60_000)).toBe(false);
    expect(markPendingHint('om_h', f, NOW + HINT_INTERVAL_MS + 1)).toBe(true);
    expect(markPendingHint('om_nobody', f, NOW)).toBe(false);
  });
});

describe('switchThreadProject：会话话题里 /run 点名别的项目 → 新开会话（2026-09-13 真机）', () => {
  it('点名不同项目的 run 保留为 run 并带上项目；同项目、没点名、非 run 都不动', () => {
    expect(switchThreadProject({ kind: 'run', text: '/run odoo-product 速卖通刊登状态' }, 'lakeghost', 'odoo-product')).toEqual({ kind: 'run', text: '/run odoo-product 速卖通刊登状态', project: 'odoo-product' });
    expect(switchThreadProject({ kind: 'run', text: 'x' }, 'lakeghost', 'lakeghost')).toBeNull();
    expect(switchThreadProject({ kind: 'run', text: 'x' }, 'lakeghost', undefined)).toBeNull();
    expect(switchThreadProject({ kind: 'followup', text: 'x' }, 'lakeghost', 'odoo-product')).toBeNull();
    expect(switchThreadProject({ kind: 'run', text: 'x' }, undefined, 'odoo-product')).toBeNull();
  });
});
