import fs from 'node:fs';
import path from 'node:path';
import { asksToCreateTicket, type Command } from './commands.js';
import type { LastRun, Round } from './followup.js';
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
  /**
   * 话题里没 @ 机器人的话（拍板 2026-09-11）：不触发、不回复，攒着；下一次有人 @ 时连同那句一起交给会话/工单。
   * 上限 20 条 / 24 小时，超了丢最早的
   */
  pending?: Array<{ sender: string; text: string; ts: string }>;
  /** 上次在攒下的「像指令」的话上加 👀 的时间：每话题每小时最多提示一次 */
  hintedAt?: string;
}

export const PENDING_CAP = 20;
export const PENDING_TTL_MS = 24 * 3600_000;

/** 攒一句没 @ 的话（只对已绑定的话题；未绑定的话题不是在跟机器人说话，不记） */
export function pushPending(rootId: string, sender: string, text: string, file = threadsFile(), now = Date.now()): number {
  const all = readThreads(file);
  const rec = all[rootId];
  if (!rec) return 0;
  const fresh = (rec.pending ?? []).filter((p) => now - Date.parse(p.ts) <= PENDING_TTL_MS);
  fresh.push({ sender, text: text.slice(0, 1000), ts: new Date(now).toISOString() });
  rec.pending = fresh.slice(-PENDING_CAP);
  rec.lastAt = new Date(now).toISOString();
  writeThreads(all, file, now);
  return rec.pending.length;
}

/** 取走并清空攒下的话 */
export function takePending(rootId: string, file = threadsFile(), now = Date.now()): Array<{ sender: string; text: string; ts: string }> {
  const all = readThreads(file);
  const rec = all[rootId];
  if (!rec?.pending?.length) return [];
  const out = rec.pending.filter((p) => now - Date.parse(p.ts) <= PENDING_TTL_MS);
  rec.pending = [];
  writeThreads(all, file, now);
  return out;
}

/** 攒下的话渲染成给会话/工单看的段落（发送人只留 open_id 尾 6 位——会话不需要知道是谁，只需要知道不是同一个人） */
export function renderPending(items: Array<{ sender: string; text: string; ts: string }>): string {
  if (!items.length) return '';
  return [
    '（这期间话题里还有以下讨论，供参考，以最后 @ 你的那句为准）',
    ...items.map((p) => `- [${p.ts.slice(11, 16)} ${p.sender.slice(-6)}] ${p.text.replace(/\s+/g, ' ').slice(0, 300)}`),
  ].join('\n');
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
    // 过程留一份压缩版（最近 12 轮、每轮几百字）：会话到期重开时靠它接手。此前不存 transcript，重开的会话只拿到
    // 上次输出前 600 字——2026-09-12 真机：第 29 轮用内网生图接口跑了 282 张图，第 31 轮（新会话）却说「环境里没有生图工具」
    run: { ...run, output: run.output.slice(0, STORED_OUTPUT_CAP), transcript: compactRounds(run.transcript ?? [{ command: run.command, output: run.output }]) },
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

/** 压缩留存的过程：最近多少轮、每轮用户原话与输出各留多少字 */
export const BRIEF_ROUNDS = 12;
const BRIEF_COMMAND_CAP = 200;
const BRIEF_OUTPUT_CAP = 400;
/** 会话按提示词约定在结尾写的「用到的工具：…」行——不管在输出多后面都要留住，重开的会话靠它知道接口/脚本 */
const TOOLS_LINE = /^\s*[-*]?\s*\**用到的工具\**[:：].*/gm;

/** 每轮只留头几百字 + 工具行；轮数只留最近的（老轮次的全文在 data/adhoc/ 留痕） */
export function compactRounds(rounds: Round[]): Round[] {
  return rounds.slice(-BRIEF_ROUNDS).map((r) => {
    const head = r.output.slice(0, BRIEF_OUTPUT_CAP);
    const tools = (r.output.match(TOOLS_LINE) ?? []).map((l) => l.trim()).filter((l) => !head.includes(l));
    return { command: r.command.slice(0, BRIEF_COMMAND_CAP), output: [head, ...tools].join('\n') };
  });
}

/**
 * 到期会话的开场摘要：新会话第一句带上原任务 + 最近各轮「用户说了什么 → 输出开头 / 用到的工具」。
 * 不重放全史（老轮次留痕在 data/adhoc/），但过程里出现过的接口、脚本、文件路径要跟过去——那是新会话接手的全部依据
 */
export function expiredSessionBrief(rec: ThreadRec): string | null {
  if (!rec.run) return null;
  const rounds = compactRounds(rec.run.transcript ?? [{ command: rec.run.command, output: rec.run.output }]);
  const lines = rounds.map((r, i) => `[${i + 1}/${rounds.length}] 用户：${r.command}\n→ ${r.output}`);
  return [
    `（这个话题此前有一段对话，会话已到期重开。原任务：${(rec.run.origin ?? rec.run.command).slice(0, 200)}`,
    `以下是最近 ${rounds.length} 轮的过程摘要（按时间顺序）；其中提到的接口、脚本、文件路径在本会话同样可用，直接接着用，不要说「环境里没有」：`,
    ...lines,
    '）',
  ].join('\n');
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
  // 会话话题里分类器猜出的 new 也按续聊：那多半是在给会话提意见（2026-09-11 真机：同事一句「服装类目不用指定模特…更换背景就行」
  // 被判 new@65%，差点建成工单）。人明确说「建单/开工单」或亲手打 /new 的仍然建单
  const guessedNew = cmd.kind === 'new' && !text.trim().startsWith('/') && !asksToCreateTicket(text);
  if ((th?.run || rootIsRunCard) && (cmd.kind === 'followup' || cmd.kind === 'run' || cmd.kind === 'unknown' || guessedNew)) {
    // 话题里人习惯照旧打 /run、/re（真机 2026-09-10）：续聊正文不该带着指令前缀。
    // 分类器判出的对外副作用要带过去：run 变成 followup 不能把部署/推送的确认闸门一起变没
    const sideEffect = cmd.kind === 'run' || cmd.kind === 'followup' ? cmd.sideEffect : undefined;
    return { kind: 'followup', text: text.replace(/^\/(re|run)\s*/i, '').trim() || '继续', ...(sideEffect ? { sideEffect } : {}) };
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

/** 攒下的话像不像给机器人下的指令：动词开头，或「吧/一下/一遍」收尾，且不是问句。词面判定，漏判等于现状、误判多一个表情 */
export function looksLikeInstruction(text: string): boolean {
  const t = text.trim();
  if (!t || /[？?]\s*$/.test(t) || t.length > 200) return false;
  return /^(请|麻烦|直接|先|再|就)?(执行|开始|继续|重新|重跑|再跑|跑|帮我|生成|改|查|试|做|处理|更新|导出|发|把)/.test(t) || /(吧|一下|一遍|一次)\s*[。.!！]?$/.test(t);
}

export const HINT_INTERVAL_MS = 3600_000;

/** 这条攒下的「像指令」的话要不要加 👀 提示：每话题每小时最多一次；返回 true 即已记下本次提示时间 */
export function markPendingHint(rootId: string, file = threadsFile(), now = Date.now()): boolean {
  const all = readThreads(file);
  const rec = all[rootId];
  if (!rec) return false;
  if (rec.hintedAt && now - Date.parse(rec.hintedAt) < HINT_INTERVAL_MS) return false;
  rec.hintedAt = new Date(now).toISOString();
  writeThreads(all, file, now);
  return true;
}
