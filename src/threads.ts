import fs from 'node:fs';
import path from 'node:path';
import type { Command } from './commands.js';
import type { LastRun } from './followup.js';
import { dataDir } from './paths.js';

/**
 * 话题 = 会话（设计稿 docs/design/2026-09-09-thread-context.md §3）。
 * 键是飞书话题根消息 id（root_id）。不变量：一个话题至多绑一个工单、至多一个活的 /run 会话。
 * 群维度的 last-run.<chat>.json 仍在，只服务群主线兜底；run-sessions.json（结果卡 → 会话）是本表的特例——
 * 卡就是根：读不到话题记录时回落到它，不迁移历史。写入 best-effort：记不上只是续不上聊，不能反过来影响送达。
 */
export interface ThreadRec {
  chatId: string;
  project?: string;
  /** 工单话题：该话题里的每句话都确定属于这张单 */
  ticket?: string;
  /** 对话会话：最近一轮 /run（含 sessionId） */
  run?: LastRun;
  createdAt: string;
  lastAt: string;
  /** 会话轮次（首轮 1）；与 lastAt 一起决定会话寿命 */
  turns: number;
}

export type Threads = Record<string, ThreadRec>;

/** 会话寿命（拍板 2026-09-10）：超 30 轮或 7 天不活跃 → 下一句开新会话（带摘要），不再 --resume */
export const THREAD_SESSION_MAX_TURNS = 30;
export const THREAD_SESSION_IDLE_MS = 7 * 24 * 3600_000;
const THREADS_CAP = 500;
const THREADS_TTL_MS = 60 * 24 * 3600_000;
const STORED_OUTPUT_CAP = 8000;

const threadsFile = (): string => path.join(dataDir(), 'threads.json');

export function readThreads(file = threadsFile()): Threads {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8')) as Threads;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeThreads(all: Threads, file: string, now: number): void {
  try {
    // 修剪：过期的删，超量的按最近活动删最老的
    const entries = Object.entries(all).filter(([, r]) => now - Date.parse(r.lastAt) <= THREADS_TTL_MS);
    entries.sort((a, b) => Date.parse(a[1].lastAt) - Date.parse(b[1].lastAt));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(entries.slice(-THREADS_CAP))), 'utf-8');
  } catch {
    /* 见文件头注 */
  }
}

export function getThread(rootId: string | undefined, file = threadsFile()): ThreadRec | null {
  if (!rootId) return null;
  const r = readThreads(file)[rootId];
  return r && typeof r.chatId === 'string' ? r : null;
}

/** 工单 → 话题根（工单卡片/进度的投递地址）。一张单只会绑一个话题，取最近的 */
export function threadOfTicket(ticket: string, file = threadsFile()): { rootId: string; rec: ThreadRec } | null {
  let best: { rootId: string; rec: ThreadRec } | null = null;
  for (const [rootId, rec] of Object.entries(readThreads(file))) {
    if (rec.ticket === ticket && (!best || rec.lastAt > best.rec.lastAt)) best = { rootId, rec };
  }
  return best;
}

export function bindTicketThread(rootId: string, ticket: string, chatId: string, project?: string, file = threadsFile(), now = Date.now()): void {
  const all = readThreads(file);
  const at = new Date(now).toISOString();
  const prev = all[rootId];
  all[rootId] = { chatId, project, ticket, createdAt: prev?.createdAt ?? at, lastAt: at, turns: prev?.turns ?? 0, run: prev?.run };
  writeThreads(all, file, now);
}

/** 一轮 /run 在话题里跑完：会话记到话题上，轮次 +1（首轮建记录） */
export function rememberThreadRun(rootId: string, chatId: string, run: LastRun, file = threadsFile(), now = Date.now()): void {
  const all = readThreads(file);
  const at = new Date(now).toISOString();
  const prev = all[rootId];
  // 换了会话（寿命到期后新开）轮次归 1；同一会话续着数
  const sameSession = prev?.run?.sessionId && prev.run.sessionId === run.sessionId;
  all[rootId] = {
    chatId,
    project: run.project,
    ticket: prev?.ticket,
    run: { ...run, output: run.output.slice(0, STORED_OUTPUT_CAP), transcript: undefined },
    createdAt: prev?.createdAt ?? at,
    lastAt: at,
    turns: sameSession ? (prev?.turns ?? 0) + 1 : 1,
  };
  writeThreads(all, file, now);
}

/** 话题会话还能不能 --resume：轮次与闲置时间任一超限就该换新会话 */
export function sessionFresh(rec: ThreadRec, now = Date.now()): boolean {
  return rec.turns < THREAD_SESSION_MAX_TURNS && now - Date.parse(rec.lastAt) < THREAD_SESSION_IDLE_MS;
}

/** 到期会话的开场摘要：新会话第一句带上旧会话最后一次输出的前 600 字，不重放全史 */
export function expiredSessionBrief(rec: ThreadRec): string | null {
  if (!rec.run) return null;
  return `（这个话题此前有一段对话，会话已到期重开。上次的任务：${(rec.run.origin ?? rec.run.command).slice(0, 200)}\n上次输出摘要：${rec.run.output.slice(0, 600)}）`;
}

/**
 * 话题路由（设计稿 §3.4）：分类器给出的意图按话题绑定收口——
 *  - 工单话题：缺工单号的补上；「续聊 / 没听懂」在这里就是对这张单的补充说明；明确指名别的单的照旧
 *  - 会话话题（或话题根就是一张结果卡）：续聊 / 新问 / 没听懂 → 续那次会话
 *  - 都没绑：原样返回（首轮 /run 跑完会把会话记到话题上）
 * 纯函数：返回同一引用表示「没改」
 */
export function routeInThread(cmd: Command, th: ThreadRec | null, text: string, rootIsRunCard: boolean): Command {
  if (th?.ticket) {
    const t = th.ticket;
    switch (cmd.kind) {
      case 'status':
      case 'answer':
        return cmd.ticket ? cmd : { ...cmd, ticket: t };
      case 'followup':
      case 'unknown':
        return { kind: 'note', ticket: t, text: cmd.text };
      default:
        return cmd;
    }
  }
  if ((th?.run || rootIsRunCard) && (cmd.kind === 'followup' || cmd.kind === 'run' || cmd.kind === 'unknown')) {
    return { kind: 'followup', text: text.replace(/^\/re\s*/i, '').trim() || '继续' };
  }
  return cmd;
}

/** 记一次活动（工单话题里的人话）：只刷 lastAt */
export function touchThread(rootId: string, file = threadsFile(), now = Date.now()): void {
  const all = readThreads(file);
  if (!all[rootId]) return;
  all[rootId].lastAt = new Date(now).toISOString();
  writeThreads(all, file, now);
}
