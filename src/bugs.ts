import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';
import { readReq, REQ_RE } from './requirements.js';
import { withOutputLock, writeOutputJson, OutputConfigurationConflictError } from './output/configuration.js';

export const BUG_STATUSES = ['待分诊', '待复现', '待修复', '修复中', '待上线', '待验证', '已关闭', '重复', '已转需求', '使用问题'] as const;
export const BUG_SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;
export const BUG_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type BugStatus = typeof BUG_STATUSES[number];
export type BugSeverity = typeof BUG_SEVERITIES[number];
export type BugPriority = typeof BUG_PRIORITIES[number];
export interface BugInput {
  project: string; repo: string; requester: string; raw: string; title?: string;
  chatId?: string; rootId?: string; messageId?: string; evidenceRefs?: string[]; requestId?: string; reportedAt?: string;
}
export interface BugCard {
  title: string; actual: string; expected: string; impact: string;
  reproductionSteps: string[]; analysis: string; questions: string[];
  suggestedClassification?: 'defect' | 'usage' | 'requirement' | 'duplicate'; evidenceRefs?: string[];
}
export interface BugFields { title?: string; severity?: BugSeverity; priority?: BugPriority; owner?: string; summary?: string; }
interface ActionMeta { requestId?: string; reason?: string; }
export type BugAction = ActionMeta & (
  | ({ type: 'triage' | 'update' } & BugFields)
  | { type: 'refine'; card: BugCard }
  | { type: 'bind-thread'; chatId: string; rootId: string }
  | { type: 'need-info'; reason: string }
  | { type: 'supplement'; raw: string; evidenceRefs?: string[] }
  | { type: 'reproduce'; result: 'reproduced' | 'located' | 'not-reproduced'; evidenceRefs: string[] }
  | { type: 'reserve-ticket' | 'link-ticket'; ticket: string; token: string }
  | { type: 'ticket-start-failed'; ticket: string; token: string; reason: string }
  | { type: 'fix-ready'; ticket: string; fixVersion: string; evidenceRefs: string[] }
  | { type: 'deploy'; fixVersion: string; deployedVersion: string; evidenceRefs: string[] }
  | { type: 'verify-pass' | 'verify-fail'; round: number; fixVersion: string; deployedVersion: string; evidenceRefs: string[] }
  | { type: 'reopen'; reason: string }
  | { type: 'duplicate'; duplicateOf: string; reason: string }
  | { type: 'reclassify'; classification: 'usage' | 'requirement'; relatedTicket?: string; relatedRequirement?: string; reason: string }
);
export interface BugTicketAttempt { ticket: string; token: string; round: number; status: 'reserved' | 'linked' | 'failed'; }
export interface BugHistoryEntry {
  revision: number; at: string; actor: string; reason?: string; action: BugAction | { type: 'create'; requestId?: string; input: BugInput };
  from?: BugStatus; to: BugStatus; round: number;
}
export interface BugRecord {
  id: string; revision: number; createdAt: string; updatedAt: string;
  project: string; repo: string; requester: string; title: string; raw: string;
  chatId?: string; rootId?: string; messageId?: string; requestId?: string; reportedAt?: string; card?: BugCard;
  status: BugStatus; severity: BugSeverity; priority: BugPriority; owner?: string; summary?: string;
  round: number; waitingForInfo?: { reason: string; since: string; actor: string };
  originalEvidenceRefs: string[]; evidenceRefs: string[]; supplements: Array<{ raw: string; evidenceRefs: string[]; at: string; actor: string }>;
  reproduction?: { result: 'reproduced' | 'located' | 'not-reproduced'; evidenceRefs: string[]; round: number };
  ticket?: string; fixAttempt?: BugTicketAttempt; ticketAttempts: BugTicketAttempt[];
  fixVersion?: string; deployedVersion?: string; duplicateOf?: string; relatedTicket?: string; relatedRequirement?: string;
  history: BugHistoryEntry[];
}
export class BugStoreError extends Error { readonly code: string = 'BUG_STORE'; }
export class BugConflictError extends BugStoreError { readonly code = 'BUG_CONFLICT'; }
const directory = (): string => path.join(dataDir(), 'bugs');
export const BUG_RE = /^BUG-\d{3,}$/;
const validId = (id: string): boolean => BUG_RE.test(id);
const fail = (message: string): never => { throw new BugStoreError(message); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const references = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
const terminal = (status: BugStatus): boolean => ['已关闭', '重复', '已转需求', '使用问题'].includes(status);

function locked<T>(operation: () => T): T {
  fs.mkdirSync(directory(), { recursive: true });
  try { return withOutputLock(path.join(directory(), '.write.lock'), operation); }
  catch (error) {
    if (error instanceof OutputConfigurationConflictError) throw new BugConflictError('Bug 数据正在写入，请刷新重试；崩溃遗留锁需停止所有写入进程后显式清理');
    throw error;
  }
}
function persist(bug: BugRecord): BugRecord {
  writeOutputJson(path.join(directory(), `${bug.id}.json`), bug);
  return bug;
}
export function readBug(id: string): BugRecord | null {
  if (!validId(id)) return null;
  try {
    const bug = JSON.parse(fs.readFileSync(path.join(directory(), `${id}.json`), 'utf8')) as BugRecord;
    if (bug.id !== id || !BUG_STATUSES.includes(bug.status) || !Number.isSafeInteger(bug.revision) || !Array.isArray(bug.history)) return fail('Bug 存储格式不合法');
    return bug;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function listBugs(): BugRecord[] {
  let names: string[];
  try { names = fs.readdirSync(directory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).map(name => readBug(name.slice(0, -5))!)
    .filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
export function bugByTicket(ticket: string): BugRecord | null {
  return listBugs().find(bug => bug.ticketAttempts.some(attempt => attempt.ticket === ticket) || bug.relatedTicket === ticket) ?? null;
}
export function bugByThread(chatId: string, rootId: string): BugRecord | null {
  return listBugs().find(bug => bug.chatId === chatId && bug.rootId === rootId) ?? null;
}
export function createBug(input: BugInput, actor = input?.requester): BugRecord {
  if (!input || !nonempty(input.project) || !nonempty(input.repo) || !path.isAbsolute(input.repo) || !nonempty(input.requester)
    || !nonempty(input.raw) || !nonempty(actor) || (input.evidenceRefs !== undefined && !references(input.evidenceRefs))
    || ['title', 'chatId', 'rootId', 'messageId', 'requestId', 'reportedAt'].some(key => input[key as keyof BugInput] !== undefined && !nonempty(input[key as keyof BugInput]))
    || (input.reportedAt !== undefined && !Number.isFinite(Date.parse(input.reportedAt)))) return fail('Bug 登记字段不合法');
  return locked(() => {
    const source: BugInput = { project: input.project, repo: path.resolve(input.repo), requester: input.requester, raw: input.raw, evidenceRefs: [...(input.evidenceRefs ?? [])] };
    for (const key of ['title', 'chatId', 'rootId', 'messageId', 'requestId', 'reportedAt'] as const) if (input[key] !== undefined) Object.assign(source, { [key]: key === 'title' ? input[key]!.trim() : input[key] });
    const existing = listBugs().find(bug => (input.requestId && bug.requestId === input.requestId)
      || (input.messageId && bug.messageId === input.messageId && bug.chatId === input.chatId));
    if (existing) {
      const original = existing.history[0].action;
      // A request ID can be added when retrying an already registered source message.
      if (original.type !== 'create' || actionFingerprint({ ...original.input, requestId: undefined }) !== actionFingerprint({ ...source, requestId: undefined })) throw new BugConflictError('同一登记请求包含不同内容');
      return existing;
    }
    const at = new Date().toISOString();
    const number = listBugs().reduce((max, bug) => Math.max(max, Number(bug.id.slice(4))), 0) + 1;
    return persist({ id: `BUG-${String(number).padStart(3, '0')}`, revision: 1, createdAt: at, updatedAt: at,
      project: input.project, repo: path.resolve(input.repo), requester: input.requester, raw: input.raw,
      title: input.title?.trim() ?? input.raw.trim().slice(0, 100),
      ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.rootId ? { rootId: input.rootId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}), ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.reportedAt ? { reportedAt: input.reportedAt } : {}),
      status: '待分诊', severity: 'S3', priority: 'P2', round: 1,
      originalEvidenceRefs: [...(input.evidenceRefs ?? [])], evidenceRefs: [...(input.evidenceRefs ?? [])], supplements: [], ticketAttempts: [],
      history: [{ revision: 1, at, actor, reason: '登记问题', action: { type: 'create', input: source, ...(input.requestId ? { requestId: input.requestId } : {}) }, to: '待分诊', round: 1 }],
    });
  });
}

function validateAction(action: BugAction): void {
  if (!action || typeof action !== 'object' || !nonempty(action.type)) return fail('Bug 操作不合法');
  const fields: Record<string, string[]> = {
    triage: ['title', 'severity', 'priority', 'owner', 'summary'], update: ['title', 'severity', 'priority', 'owner', 'summary'],
    refine: ['card'], 'bind-thread': ['chatId', 'rootId'],
    'need-info': [], supplement: ['raw', 'evidenceRefs'], reproduce: ['result', 'evidenceRefs'],
    'reserve-ticket': ['ticket', 'token'], 'link-ticket': ['ticket', 'token'], 'ticket-start-failed': ['ticket', 'token'],
    'fix-ready': ['ticket', 'fixVersion', 'evidenceRefs'], deploy: ['fixVersion', 'deployedVersion', 'evidenceRefs'],
    'verify-pass': ['round', 'fixVersion', 'deployedVersion', 'evidenceRefs'], 'verify-fail': ['round', 'fixVersion', 'deployedVersion', 'evidenceRefs'],
    reopen: [], duplicate: ['duplicateOf'], reclassify: ['classification', 'relatedTicket', 'relatedRequirement'],
  };
  const allowed = fields[action.type];
  if (!allowed || Object.keys(action).some(key => !['type', 'requestId', 'reason', ...allowed].includes(key))) return fail('Bug 操作包含非法字段');
  for (const [key, value] of Object.entries(action)) {
    if (key === 'card') { validateCard(value); }
    else if (key === 'evidenceRefs') { if (!references(value)) return fail('证据引用不合法'); }
    else if (key === 'round') { if (!Number.isSafeInteger(value) || value < 1) return fail('验证轮次不合法'); }
    else if (value !== undefined && !nonempty(value)) return fail('Bug 操作字段不能为空');
  }
  if ('severity' in action && action.severity !== undefined && !BUG_SEVERITIES.includes(action.severity)) return fail('严重程度不合法');
  if ('priority' in action && action.priority !== undefined && !BUG_PRIORITIES.includes(action.priority)) return fail('优先级不合法');
  const required: Record<string, string[]> = {
    refine: ['card'], 'bind-thread': ['chatId', 'rootId'],
    'need-info': ['reason'], supplement: ['raw'], reproduce: ['result', 'evidenceRefs'],
    'reserve-ticket': ['ticket', 'token'], 'link-ticket': ['ticket', 'token'], 'ticket-start-failed': ['ticket', 'token', 'reason'],
    'fix-ready': ['ticket', 'fixVersion', 'evidenceRefs'], deploy: ['fixVersion', 'deployedVersion', 'evidenceRefs'],
    'verify-pass': ['round', 'fixVersion', 'deployedVersion', 'evidenceRefs'], 'verify-fail': ['round', 'fixVersion', 'deployedVersion', 'evidenceRefs', 'reason'],
    reopen: ['reason'], duplicate: ['duplicateOf', 'reason'], reclassify: ['classification', 'reason'],
  };
  if ((required[action.type] ?? []).some(key => (action as unknown as Record<string, unknown>)[key] === undefined)) return fail('Bug 操作缺少必填字段');
  if ('evidenceRefs' in action && action.type !== 'supplement' && !action.evidenceRefs?.length) return fail('此操作必须提供证据引用');
  if (action.type === 'reproduce' && !['reproduced', 'located', 'not-reproduced'].includes(action.result)) return fail('复现结论不合法');
  if (action.type === 'reclassify' && !['usage', 'requirement'].includes(action.classification)) return fail('分诊类别不合法');
}
function validateCard(value: unknown): asserts value is BugCard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Bug 提炼卡片不合法');
  const card = value as Record<string, unknown>;
  if (Object.keys(card).some(key => !['title', 'actual', 'expected', 'impact', 'reproductionSteps', 'analysis', 'questions', 'suggestedClassification', 'evidenceRefs'].includes(key))
    || ['title', 'actual', 'expected', 'impact', 'analysis'].some(key => !nonempty(card[key]))
    || !references(card.reproductionSteps) || !references(card.questions)
    || (card.evidenceRefs !== undefined && !references(card.evidenceRefs))
    || (card.suggestedClassification !== undefined && !['defect', 'usage', 'requirement', 'duplicate'].includes(card.suggestedClassification as string))) return fail('Bug 提炼卡片字段不合法');
}
function actionFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(actionFingerprint).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${actionFingerprint(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function applyBugAction(id: string, expectedRevision: number, action: BugAction, actor: string): BugRecord {
  validateAction(action);
  if (!nonempty(actor) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return fail('操作者或版本不合法');
  return locked(() => {
    const bug = readBug(id);
    if (!bug) return fail('Bug 不存在');
    if (action.requestId) {
      const previous = bug.history.find(entry => entry.action.requestId === action.requestId);
      if (previous) {
        if (actionFingerprint(previous.action) !== actionFingerprint(action) || previous.actor !== actor) throw new BugConflictError('同一操作请求包含不同内容');
        return bug;
      }
    }
    if (action.type === 'bind-thread' && bug.chatId === action.chatId && bug.rootId === action.rootId) return bug;
    if (action.type === 'reserve-ticket' && bug.fixAttempt?.ticket === action.ticket && bug.fixAttempt.token === action.token && bug.fixAttempt.round === bug.round && bug.fixAttempt.status !== 'failed') return bug;
    if (action.type === 'link-ticket' && bug.fixAttempt?.ticket === action.ticket && bug.fixAttempt.token === action.token && bug.fixAttempt.round === bug.round && bug.fixAttempt.status === 'linked') return bug;
    if (bug.revision !== expectedRevision) throw new BugConflictError('Bug 已变更，请刷新后重试');
    const before = bug.status;
    const at = new Date().toISOString();
    const ensure = (...states: BugStatus[]): void => { if (!states.includes(bug.status)) fail(`当前状态 ${bug.status} 不允许 ${action.type}`); };
    // Waiting blocks new business decisions, but must not strand an already started repair.
    if (bug.waitingForInfo && !['supplement', 'update', 'refine', 'bind-thread', 'need-info', 'link-ticket', 'ticket-start-failed', 'fix-ready'].includes(action.type)) return fail('请先补充所需信息');
    switch (action.type) {
      case 'triage': case 'update': {
        if (action.type === 'triage') { ensure('待分诊', '待复现'); bug.status = '待复现'; }
        for (const key of ['title', 'severity', 'priority', 'owner', 'summary'] as const) if (action[key] !== undefined) Object.assign(bug, { [key]: action[key] });
        break;
      }
      case 'refine':
        bug.card = structuredClone(action.card); bug.title = action.card.title; break;
      case 'bind-thread':
        if ((bug.chatId && bug.chatId !== action.chatId) || (bug.rootId && bug.rootId !== action.rootId)) throw new BugConflictError('Bug 已绑定其他话题');
        bug.chatId = action.chatId; bug.rootId = action.rootId; break;
      case 'need-info':
        if (terminal(bug.status)) return fail('已结束的问题不能等待补充');
        bug.waitingForInfo = { reason: action.reason, actor, since: at }; break;
      case 'supplement':
        bug.supplements.push({ raw: action.raw, evidenceRefs: [...(action.evidenceRefs ?? [])], actor, at });
        delete bug.waitingForInfo; break;
      case 'reproduce':
        ensure('待复现', '待修复');
        bug.reproduction = { result: action.result, evidenceRefs: action.evidenceRefs, round: bug.round };
        bug.status = action.result === 'not-reproduced' ? '待复现' : '待修复'; break;
      case 'reserve-ticket': {
        ensure('待修复');
        if (bug.fixAttempt && bug.fixAttempt.status !== 'failed') return fail('本轮已预留修复工单');
        if (listBugs().some(other => other.ticketAttempts.some(attempt => attempt.ticket === action.ticket || attempt.token === action.token))) throw new BugConflictError('工单或请求令牌已被预留');
        const attempt: BugTicketAttempt = { ticket: action.ticket, token: action.token, round: bug.round, status: 'reserved' };
        bug.fixAttempt = attempt; bug.ticketAttempts.push(attempt); bug.ticket = action.ticket; bug.status = '修复中'; break;
      }
      case 'link-ticket': case 'ticket-start-failed': {
        ensure('修复中');
        const attempt = bug.fixAttempt;
        if (!attempt || attempt.ticket !== action.ticket || attempt.token !== action.token || attempt.round !== bug.round) return fail('工单预留与当前轮次不匹配');
        if (attempt.status !== 'reserved') return fail('工单预留已处理');
        attempt.status = action.type === 'link-ticket' ? 'linked' : 'failed';
        // The parsed current attempt and history list are separate objects.
        bug.ticketAttempts.find(item => item.token === attempt.token)!.status = attempt.status;
        if (attempt.status === 'failed') bug.status = '待修复';
        break;
      }
      case 'fix-ready':
        ensure('修复中');
        if (bug.fixAttempt?.status !== 'linked' || bug.ticket !== action.ticket || bug.fixAttempt.round !== bug.round) return fail('修复工单与当前轮次不匹配');
        bug.fixVersion = action.fixVersion; bug.status = '待上线'; break;
      case 'deploy':
        ensure('待上线');
        if (bug.fixVersion !== action.fixVersion) throw new BugConflictError('上线修复版本不匹配');
        bug.deployedVersion = action.deployedVersion; bug.status = '待验证'; break;
      case 'verify-pass': case 'verify-fail':
        ensure('待验证');
        if (bug.round !== action.round || bug.fixVersion !== action.fixVersion || bug.deployedVersion !== action.deployedVersion) throw new BugConflictError('验证轮次或上线版本已变化');
        if (action.type === 'verify-pass') bug.status = '已关闭';
        else startRound(bug);
        break;
      case 'reopen':
        if (!terminal(bug.status)) return fail('仅已结束的问题可重新打开');
        startRound(bug); break;
      case 'duplicate':
        ensure('待分诊', '待复现', '待修复');
        if (action.duplicateOf === bug.id || !readBug(action.duplicateOf)) return fail('重复问题必须关联其他现有 Bug');
        {
          const seen = new Set([bug.id]);
          let target: BugRecord | null = readBug(action.duplicateOf);
          while (target) {
            if (seen.has(target.id)) return fail('重复问题关联不能成环');
            seen.add(target.id);
            target = target.duplicateOf ? readBug(target.duplicateOf) : null;
          }
        }
        bug.duplicateOf = action.duplicateOf; bug.status = '重复'; break;
      case 'reclassify':
        ensure('待分诊', '待复现', '待修复');
        if (action.classification === 'requirement') {
          const requirement = action.relatedRequirement && REQ_RE.test(action.relatedRequirement) ? readReq(action.relatedRequirement) : null;
          if (!requirement || requirement.project !== bug.project) return fail('转需求必须关联同项目的真实需求记录');
          bug.relatedRequirement = requirement.id;
        }
        bug.status = action.classification === 'usage' ? '使用问题' : '已转需求';
        if (action.relatedTicket) bug.relatedTicket = action.relatedTicket;
        break;
    }
    if ('evidenceRefs' in action) bug.evidenceRefs.push(...(action.evidenceRefs ?? []).filter(ref => !bug.evidenceRefs.includes(ref)));
    bug.revision++;
    bug.updatedAt = at;
    bug.history.push({ revision: bug.revision, at, actor, reason: action.reason ?? action.type, action: structuredClone(action), from: before, to: bug.status, round: bug.round });
    return persist(bug);
  });
}
function startRound(bug: BugRecord): void {
  bug.round++;
  bug.status = '待复现';
  delete bug.fixAttempt; delete bug.ticket; delete bug.fixVersion; delete bug.deployedVersion;
  delete bug.reproduction; delete bug.duplicateOf; delete bug.relatedTicket; delete bug.relatedRequirement;
}
