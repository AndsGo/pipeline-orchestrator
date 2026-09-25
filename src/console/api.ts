import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FIX_ROUND_CAP, IMPLEMENT_AUTO_CONTINUE_CAP, STAGE_EFFORT, STAGES } from '../config.js';
import { ENV_GROUPS, envKeySpec, parseEnvText, type EnvKeySpec } from '../envKeys.js';
import { isClosure, listTickets, readEvents, totalCost, type PipelineEvent } from '../events.js';
import { readEnvVar, upsertEnvVar } from '../onboarding.js';
import { isPaused } from '../pause.js';
import { dataDir } from '../paths.js';
import { loadProjects, type Project } from '../projects.js';
import { listReqs } from '../requirements.js';
import { readSnapshot } from '../ticket.js';
import type { TicketState } from '../types.js';
import type { RuntimeSnapshot } from '../daemon/lifecycle.js';

/**
 * 控制台的数据装配层：只读文件、只写 .env 与信号文件，不碰飞书。全部可用临时目录单测。
 * 与 daemon 之间的契约见 daemon/lifecycle.ts（runtime.json / env.reload / console.queue.jsonl）。
 */

// ---------- 环境配置 ----------

export interface EnvFieldView extends EnvKeySpec {
  set: boolean;
  length: number;
  /** 非 secret 才有 */
  value?: string;
}

export interface EnvView {
  mtime: number;
  groups: Array<{ name: string; keys: EnvFieldView[] }>;
}

function fieldView(spec: EnvKeySpec, value: string | undefined): EnvFieldView {
  const v = value ?? '';
  return { ...spec, set: v !== '', length: v.length, ...(spec.secret ? {} : { value: v }) };
}

export function readEnvView(envFile: string): EnvView {
  const text = fs.readFileSync(envFile, 'utf-8');
  const parsed = parseEnvText(text);
  const known = new Set<string>();
  const groups = ENV_GROUPS.map((g) => ({
    name: g.name,
    keys: g.keys.map((k) => {
      known.add(k.key);
      return fieldView(k, parsed[k.key]);
    }),
  }));
  const extra = Object.keys(parsed)
    .filter((k) => !known.has(k))
    .map((k) => fieldView(envKeySpec(k), parsed[k]));
  if (extra.length) groups.push({ name: '其他（目录外，按凭据遮蔽）', keys: extra });
  return { mtime: fs.statSync(envFile).mtimeMs, groups };
}

/** .env 整份备份进 backups/（已 gitignore），与 /bind、/addproject 同一去处；绝不在仓库根留 .env.bak */
function backupEnv(envFile: string): string {
  const backup = path.resolve(path.dirname(envFile), 'backups', `env-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(envFile, backup);
  return backup;
}

export type WriteResult = { ok: true; needsRestart: string[] } | { ok: false; error: string };

/**
 * 改 .env：乐观锁（mtime 变了拒绝，让人重新加载再改）→ 备份 → 逐键精确改行。
 * 值里不能有换行（.env 一行一变量，多出来的行会被当成别的键）。secret 键传空串视为「不改」由调用方处理。
 */
export function writeEnvChanges(envFile: string, expectedMtime: number, changes: Record<string, string>): WriteResult {
  const keys = Object.keys(changes).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  if (!keys.length) return { ok: false, error: '没有要改的键' };
  for (const k of keys) if (/[\r\n]/.test(changes[k])) return { ok: false, error: `${k} 的值不能含换行` };
  if (Math.abs(fs.statSync(envFile).mtimeMs - expectedMtime) > 1) return { ok: false, error: '.env 在你加载之后被别处改过（/bind、/addproject 或另一个页面），请刷新后重试' };
  backupEnv(envFile);
  let text = fs.readFileSync(envFile, 'utf-8');
  for (const k of keys) text = upsertEnvVar(text, k, changes[k]);
  fs.writeFileSync(envFile, text, 'utf-8');
  return { ok: true, needsRestart: keys.filter((k) => envKeySpec(k).restart).map((k) => `${k}（${envKeySpec(k).restart}）`) };
}

// ---------- 项目配置 ----------

export type ProjectFields = Omit<Project, 'alias'>;

/** 页面读的是 .env 文件里的项目表，不是控制台自己进程的环境（那是启动时的旧值） */
export function readProjectsView(envFile: string): { mtime: number; projects: Project[] } {
  const text = fs.readFileSync(envFile, 'utf-8');
  return { mtime: fs.statSync(envFile).mtimeMs, projects: loadProjects({ PIPELINE_PROJECTS: readEnvVar(text, 'PIPELINE_PROJECTS') ?? undefined }) };
}

/** 整表校验（新建与改名走同一套规则；validateNewProject 只管「加一个」，这里要管整表互斥） */
export function validateProjects(list: Project[], dirExists: (p: string) => boolean = (p) => fs.existsSync(p)): string[] {
  const errs: string[] = [];
  if (!list.length) errs.push('至少要有一个项目');
  const seenAlias = new Map<string, string>();
  const seenPrefix = new Map<string, string>();
  for (const p of list) {
    if (!/^[a-z][a-z0-9-]*$/i.test(p.alias)) errs.push(`别名「${p.alias}」不合法（字母开头，只含字母数字-）`);
    const a = p.alias.toLowerCase();
    if (seenAlias.has(a)) errs.push(`别名「${p.alias}」重复`);
    seenAlias.set(a, p.alias);
    if (!/^[A-Za-z]{1,6}$/.test(p.prefix)) errs.push(`${p.alias}：前缀「${p.prefix}」不合法（1-6 个字母）`);
    const pf = p.prefix.toLowerCase();
    if (seenPrefix.has(pf)) errs.push(`${p.alias}：前缀「${p.prefix}」与项目 ${seenPrefix.get(pf)} 冲突`);
    seenPrefix.set(pf, p.alias);
    if (!p.repo.trim()) errs.push(`${p.alias}：仓库路径不能为空`);
    else if (!dirExists(p.repo)) errs.push(`${p.alias}：仓库路径不存在 ${p.repo}`);
    if (p.owner && !/^ou_[0-9a-f]+$/i.test(p.owner)) errs.push(`${p.alias}：负责人应是 open_id（ou_ 开头）`);
    if (p.chatId && !/^oc_[0-9a-f]+$/i.test(p.chatId)) errs.push(`${p.alias}：绑定群应是 chat_id（oc_ 开头）`);
  }
  return errs;
}

/** 序列化成 .env 里的一行 JSON：空字段不写，路径统一正斜杠，前缀大写 */
export function projectsJson(list: Project[]): string {
  const raw: Record<string, ProjectFields> = {};
  for (const p of list) {
    const f: ProjectFields = { repo: p.repo.replace(/\\/g, '/'), prefix: p.prefix.toUpperCase() };
    for (const k of ['gitlab', 'jenkins', 'wikiArchive', 'wikiKnowledge', 'chatId', 'owner'] as const) {
      const v = p[k]?.trim();
      if (v) f[k] = v;
    }
    raw[p.alias] = f;
  }
  return JSON.stringify(raw);
}

export function writeProjects(envFile: string, expectedMtime: number, list: Project[]): WriteResult {
  const errs = validateProjects(list);
  if (errs.length) return { ok: false, error: errs.join('；') };
  return writeEnvChanges(envFile, expectedMtime, { PIPELINE_PROJECTS: projectsJson(list) });
}

// ---------- 总览 / 重启 ----------

export interface Overview {
  runtime: (RuntimeSnapshot & { ageSec: number }) | null;
  daemon: { pid: number | null; alive: boolean };
  /** 看门狗最后一次 RESTART 的时间（ISO，本地时区无 Z）与距今分钟数 */
  lastRestart: { at: string; minutesAgo: number } | null;
  stopPending: boolean;
  reloadPending: boolean;
  tickets: { total: number; running: number; halted: number; closed: number };
  reqs: { total: number; open: number };
  /** 今日（本地日期）stage.end 成本合计 */
  todayCost: number;
  /** 需要人处理的事，按紧急程度排 */
  attention: AttentionItem[];
}

export function readRuntime(dir = dataDir(), now = Date.now()): Overview['runtime'] {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf-8')) as RuntimeSnapshot;
    return { ...s, ageSec: Math.max(0, Math.round((now - s.at) / 1000)) };
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lastRestartFrom(watchdogLog: string, now = Date.now()): Overview['lastRestart'] {
  if (!fs.existsSync(watchdogLog)) return null;
  const lines = fs.readFileSync(watchdogLog, 'utf-8').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/ RESTART /.test(lines[i])) continue; // 大小写敏感：skip 行里的小写 restart 不算（与看门狗同口径）
    const m = /^(\S+) /.exec(lines[i]);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isNaN(t) ? null : { at: m[1], minutesAgo: Math.round((now - t) / 60_000) };
  }
  return null;
}

/** 闭环：compound 跑成功，或有「闭环」done 事件（快车道没有 compound，只认后者） */
function isClosed(st: TicketState | null, evs: PipelineEvent[]): boolean {
  return !!st?.runs.some((r) => r.stage === 'compound' && r.status === 'DONE') || evs.some(isClosure);
}

/**
 * 工单成本：以快照台账为准（与闭环摘要「N 次会话，$X」同源）；事件流早期没有记 stage.end 成本
 * （LS-002/003 实测差出 $20+），只在没有快照时兜底
 */
function ticketCost(t: string, st: TicketState | null): number {
  return st?.runs.length ? st.runs.reduce((s, r) => s + r.costUsd, 0) : totalCost(t);
}

/** 工单标题：建单事件里的需求原文（「工单建立：」之后），截到一行 */
function ticketTitle(evs: PipelineEvent[]): string | undefined {
  const created = evs.find((e) => e.type === 'ticket.created');
  return created?.summary.replace(/^工单建立[：:]\s*/, '').replace(/\s+/g, ' ').slice(0, 60) || undefined;
}

type RowState = '在跑' | '挂起' | '闭环' | '等人工' | '已暂停';

function rowState(t: string, st: TicketState | null, evs: PipelineEvent[], active: Set<string>): RowState {
  if (active.has(t)) return '在跑';
  if (st?.haltedReason) return '挂起';
  if (isClosed(st, evs)) return '闭环';
  return isPaused(t) ? '已暂停' : '等人工';
}

/** 需要人处理的一件事：总览首屏列出来，按紧急程度排 */
export interface AttentionItem {
  kind: '挂起' | '等回答' | '久未推进' | '需求待确认' | '需求待排期';
  ref: string;
  title?: string;
  detail: string;
  since?: string;
}

/** 等人工超过这么久没有任何事件，算久未推进 */
export const STALE_TICKET_MS = 3 * 86_400_000;

export function attentionItems(runtime: RuntimeSnapshot | null, now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  const active = new Set(runtime?.active ?? []);
  for (const t of listTickets()) {
    const st = readSnapshot(t);
    const evs = readEvents(t);
    const state = rowState(t, st, evs, active);
    const title = ticketTitle(evs);
    const last = evs.at(-1);
    const pending = runtime?.pending[t] ?? [];
    if (state === '挂起') out.push({ kind: '挂起', ref: t, title, detail: st!.haltedReason!, since: last?.ts });
    else if (pending.length) out.push({ kind: '等回答', ref: t, title, detail: pending.join('、'), since: last?.ts });
    else if (state === '等人工' && last && now - Date.parse(last.ts) > STALE_TICKET_MS) out.push({ kind: '久未推进', ref: t, title, detail: last.summary, since: last.ts });
  }
  for (const r of listReqs()) {
    if (r.status === '待确认') out.push({ kind: '需求待确认', ref: r.id, title: r.title, detail: `${r.project} · 等提出人或负责人确认需求说明`, since: r.updatedAt });
    else if (r.status === '待排期') out.push({ kind: '需求待排期', ref: r.id, title: r.title, detail: `${r.project} · 等负责人排期`, since: r.updatedAt });
  }
  const rank: Record<AttentionItem['kind'], number> = { 挂起: 0, 等回答: 1, 需求待确认: 2, 需求待排期: 3, 久未推进: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.since ?? '').localeCompare(b.since ?? ''));
}

export function buildOverview(opts: { dir: string; watchdogLog: string; now?: number }): Overview {
  const now = opts.now ?? Date.now();
  const runtime = readRuntime(opts.dir, now);
  let pid: number | null = null;
  try {
    pid = Number(fs.readFileSync(path.join(opts.dir, 'daemon.pid'), 'utf-8').replace(/^﻿/, '').trim()) || null;
  } catch {
    /* 无 pid 文件 */
  }
  // 存活判据：心跳 30 秒内新鲜优先（pid 文件记的是 cmd 包装层，机器重启后可能被别的进程占用）
  const alive = runtime ? runtime.ageSec < 30 : pid !== null && pidAlive(pid);
  const active = new Set(runtime?.active ?? []);
  const tickets = { total: 0, running: 0, halted: 0, closed: 0 };
  let todayCost = 0;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  for (const t of listTickets()) {
    tickets.total++;
    const st = readSnapshot(t);
    const evs = readEvents(t);
    const state = rowState(t, st, evs, active);
    if (state === '在跑') tickets.running++;
    else if (state === '挂起') tickets.halted++;
    else if (state === '闭环') tickets.closed++;
    for (const e of evs) {
      const ts = Date.parse(e.ts);
      if (e.type === 'stage.end' && ts >= dayStart && ts < dayStart + 86_400_000) todayCost += Number(e.payload?.costUsd) || 0;
    }
  }
  const reqs = listReqs();
  return {
    runtime,
    daemon: { pid, alive },
    lastRestart: lastRestartFrom(opts.watchdogLog, now),
    stopPending: fs.existsSync(path.join(opts.dir, 'daemon.stop')),
    reloadPending: fs.existsSync(path.join(opts.dir, 'env.reload')),
    tickets,
    reqs: { total: reqs.length, open: reqs.filter((r) => ['梳理中', '待确认', '待排期', '已排期', '已转工单'].includes(r.status)).length },
    todayCost,
    attention: attentionItems(runtime, now),
  };
}

// ---------- 任务 ----------

export interface TicketRowView {
  ticket: string;
  project?: string;
  title?: string;
  stage: string;
  state: RowState;
  cost: number;
  waiting?: string;
  lastAt?: string;
}

export function ticketRows(runtime: RuntimeSnapshot | null): TicketRowView[] {
  const active = new Set(runtime?.active ?? []);
  return listTickets().map((t) => {
    const st = readSnapshot(t);
    const evs = readEvents(t);
    const state = rowState(t, st, evs, active);
    const pending = runtime?.pending[t] ?? [];
    return {
      ticket: t,
      project: st?.project,
      title: ticketTitle(evs),
      stage: state === '闭环' ? '—' : (st?.cursor ?? '?'),
      state,
      cost: ticketCost(t, st),
      waiting: st?.haltedReason ? `挂起：${st.haltedReason}` : pending.length ? `等回答：${pending.join('、')}` : evs.at(-1)?.summary,
      lastAt: evs.at(-1)?.ts,
    };
  });
}

export interface TicketDetail {
  snapshot: TicketState | null;
  events: PipelineEvent[];
  title?: string;
  state: RowState;
  cost: number;
  paused: boolean;
  running: boolean;
  pending: string[];
  docs: string[];
  /** 文档里有来自功能分支（工作区没有）的 */
  docsFromBranch?: string;
}

export function ticketDetail(ticket: string, runtime: RuntimeSnapshot | null): TicketDetail | null {
  const snapshot = readSnapshot(ticket);
  const events = readEvents(ticket);
  if (!snapshot && !events.length) return null;
  const repo = snapshot?.mainRepo ?? snapshot?.repo;
  const docs = repo ? listTicketDocs(repo, ticket, snapshot?.branch) : { files: [] };
  return {
    snapshot,
    events,
    title: ticketTitle(events),
    state: rowState(ticket, snapshot, events, new Set(runtime?.active ?? [])),
    cost: ticketCost(ticket, snapshot),
    paused: isPaused(ticket),
    running: !!runtime?.active.includes(ticket),
    pending: runtime?.pending[ticket] ?? [],
    docs: docs.files,
    docsFromBranch: docs.fromBranch,
  };
}

// ---------- 文档 ----------

const DOC_EXT = new Set(['.md', '.json', '.txt', '.csv', '.html']);

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** 分支名只收 git 合法的常见字符：它来自快照，但最终拼进命令行参数 */
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * 工单目录下的文件（相对工单目录，含 prototype/index.html）。
 * 在途工单的工件提交在功能分支上，主仓库工作区里往往只有零星几个（OP-003 实测 2 个 vs 分支上 14 个），
 * 所以把分支树并进来；读取时工作区优先，没有再从分支取。
 */
export function listTicketDocs(repo: string, ticket: string, branch?: string): { files: string[]; fromBranch?: string } {
  const out = new Set<string>();
  const dir = path.join(repo, 'docs', 'pipeline', ticket);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile() && DOC_EXT.has(path.extname(f.name).toLowerCase())) out.add(f.name);
      else if (f.isDirectory() && f.name === 'prototype' && fs.existsSync(path.join(dir, f.name, 'index.html'))) out.add('prototype/index.html');
    }
  }
  let fromBranch: string | undefined;
  if (branch && BRANCH_RE.test(branch)) {
    const tree = git(repo, ['ls-tree', '-r', '--name-only', branch, '--', `docs/pipeline/${ticket}/`]);
    const prefix = `docs/pipeline/${ticket}/`;
    for (const line of tree?.split('\n') ?? []) {
      const rel = line.trim().slice(prefix.length);
      if (!line.startsWith(prefix) || !rel) continue;
      const ok = rel === 'prototype/index.html' || (!rel.includes('/') && DOC_EXT.has(path.extname(rel).toLowerCase()));
      if (ok && !out.has(rel)) {
        out.add(rel);
        fromBranch = branch;
      }
    }
  }
  return { files: [...out].sort(), fromBranch };
}

/** 读文档：工作区优先，工作区没有且工单有分支时从分支取（rel 已过 docLocalPath 的防线） */
export function readDoc(repo: string, rel: string): string | null {
  const file = docLocalPath(repo, rel);
  if (!file) return null;
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
  const ticket = rel.split('/')[0];
  const branch = /^[A-Za-z]{1,6}-\d{1,6}$/.test(ticket) ? readSnapshot(ticket)?.branch : undefined;
  if (!branch || !BRANCH_RE.test(branch)) return null;
  return git(repo, ['show', `${branch}:docs/pipeline/${rel}`]);
}

/** 项目级文档：PROJECT-BRIEF / PIPELINE.md / 系统地图页 */
export function listProjectDocs(repo: string): string[] {
  const base = path.join(repo, 'docs', 'pipeline');
  const out: string[] = [];
  for (const f of ['PROJECT-BRIEF.md', 'PIPELINE.md']) if (fs.existsSync(path.join(base, f))) out.push(f);
  const map = path.join(base, 'system-map');
  if (fs.existsSync(map)) {
    for (const f of fs.readdirSync(map)) if (/\.(md|json)$/i.test(f)) out.push(`system-map/${f}`);
  }
  return out;
}

/** 该项目有工件目录的工单号 */
export function listDocTickets(repo: string, prefix: string): string[] {
  const base = path.join(repo, 'docs', 'pipeline');
  if (!fs.existsSync(base)) return [];
  const re = new RegExp(`^${prefix}-\\d+$`, 'i');
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && re.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * 解析文档路径：锁在 <repo>/docs/pipeline/ 之内，段里不许 ..、空段、反斜杠，扩展名白名单。
 * 与 /preview/ 路由同一防线——仓库路径来自项目表，rel 来自浏览器。
 */
export function docLocalPath(repo: string, rel: string): string | null {
  const segs = rel.split('/');
  if (!rel || segs.some((s) => s === '..' || s === '' || s === '.' || s.includes('\\'))) return null;
  if (!DOC_EXT.has(path.extname(rel).toLowerCase())) return null;
  const base = path.resolve(repo, 'docs', 'pipeline');
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

// ---------- 日志 ----------

export function tailLog(file: string, lines: number, pattern?: string): { lines: string[]; total: number } {
  if (!fs.existsSync(file)) return { lines: [], total: 0 };
  let all = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
  const total = all.length;
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      all = all.filter((l) => re.test(l));
    } catch {
      all = all.filter((l) => l.includes(pattern));
    }
  }
  return { lines: all.slice(-Math.max(1, Math.min(lines, 2000))), total };
}

// ---------- 阶段参数（只读） ----------

export function stagesView(): { effort: string; fixRoundCap: number; autoContinueCap: number; stages: Array<{ stage: string } & (typeof STAGES)[keyof typeof STAGES]> } {
  return {
    effort: STAGE_EFFORT,
    fixRoundCap: FIX_ROUND_CAP,
    autoContinueCap: IMPLEMENT_AUTO_CONTINUE_CAP,
    stages: Object.entries(STAGES).map(([stage, c]) => ({ stage, ...c })),
  };
}

// ---------- 人（负责人下拉的候选） ----------

export interface PersonHint {
  openId: string;
  name?: string;
  /** 近期日志里发过几条 @ 机器人的消息 */
  messages: number;
  lastAt?: string;
}

/**
 * 最近在群里 @ 过机器人的人（daemon.log 及轮转文件里的「收到消息 by ou_x」）。
 * 机器人没开 im:chat.members:read 时读不到群成员名单，这是能拿到的最好替代：负责人通常就是常来提需求的人。
 */
export function recentSenders(logsDir: string): PersonHint[] {
  const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => /^daemon(-\d{8}-\d{6})?\.log$/.test(f)) : [];
  const map = new Map<string, PersonHint>();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf-8').split(/\r?\n/)) {
      const m = /^\[daemon\] (\S+) 收到消息 by (ou_[0-9a-f]+)/.exec(line);
      if (!m) continue;
      const p = map.get(m[2]) ?? { openId: m[2], messages: 0 };
      p.messages++;
      if (!p.lastAt || m[1] > p.lastAt) p.lastAt = m[1];
      map.set(m[2], p);
    }
  }
  return [...map.values()].sort((a, b) => b.messages - a.messages);
}
