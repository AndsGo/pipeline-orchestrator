import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from '../commands.js';
import type { LastRun } from '../followup.js';
import { chatIdOf, rootIdOf } from '../ports.js';
import {
  bindTicketThread,
  expiredSessionBrief,
  getThread,
  readThreads,
  rememberThreadRun,
  routeInThread,
  sessionFresh,
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

  it('会话话题：记会话、轮次累计，同会话 +1，换会话归 1；输出截断、transcript 不落盘', () => {
    const f = tmp();
    rememberThreadRun('om_r', 'oc_lake', run(), f, NOW);
    rememberThreadRun('om_r', 'oc_lake', run({ chain: 1 }), f, NOW + 1000);
    const rec = getThread('om_r', f)!;
    expect(rec.turns).toBe(2);
    expect(rec.run?.output.length).toBe(8000);
    expect(rec.run?.transcript).toBeUndefined();
    rememberThreadRun('om_r', 'oc_lake', run({ sessionId: 'sess-2' }), f, NOW + 2000);
    expect(getThread('om_r', f)?.turns).toBe(1);
  });

  it('会话寿命：30 轮或 7 天不活跃即到期；到期摘要带原任务与输出前 600 字', () => {
    const base: ThreadRec = { chatId: 'oc', run: run(), createdAt: 'x', lastAt: new Date(NOW).toISOString(), turns: 3 };
    expect(sessionFresh(base, NOW + 1000)).toBe(true);
    expect(sessionFresh({ ...base, turns: THREAD_SESSION_MAX_TURNS }, NOW + 1000)).toBe(false);
    expect(sessionFresh(base, NOW + 7 * 24 * 3600_000 + 1)).toBe(false);
    const brief = expiredSessionBrief(base)!;
    expect(brief).toContain('看看登录为什么慢');
    expect(brief.length).toBeLessThan(700 + 100);
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
