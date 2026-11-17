import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applyBugAction, bugByThread, bugByTicket, createBug, listBugs, readBug, type BugAction, type BugRecord } from '../bugs.js';
import { PLUGIN_DIR } from '../config.js';
import { engineFor } from '../engine/index.js';
import { isClosure, listTickets, readEvents, type PipelineEvent } from '../events.js';
import { bugActionCard, resolvedCard, type CardAction } from '../feishu/card.js';
import { dataDir } from '../paths.js';
import { chatIdOf, rootIdOf, type ChatRef } from '../ports.js';
import { mentionedProject, nextTicketId, resolveProject } from '../projects.js';
import { readSnapshot } from '../ticket.js';
import { writeOutputJson } from '../output/configuration.js';
import { bindBugThread, getThread } from '../threads.js';
import { acknowledgeBugRequest, enqueueBugRequest, pendingBugRequests, readBugRequest, type StoredBugRequest } from './bugMailbox.js';
import type { DaemonContext } from './context.js';

export interface BugAnalysis {
  title: string; actual: string; expected: string; impact: string; reproductionSteps: string[];
  suggestedClassification: 'defect' | 'usage' | 'requirement' | 'duplicate'; analysis: string; questions: string[]; evidenceRefs: string[];
}
export function parseBugAnalysis(text: string): BugAnalysis | null {
  const raw = /```bug-card\s*\n([\s\S]*?)```/.exec(text)?.[1];
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as BugAnalysis;
    if (!['title', 'actual', 'expected', 'impact', 'analysis'].every(key => typeof value[key as keyof BugAnalysis] === 'string')
      || !['reproductionSteps', 'questions', 'evidenceRefs'].every(key => Array.isArray(value[key as keyof BugAnalysis]) && (value[key as keyof BugAnalysis] as unknown[]).every(item => typeof item === 'string'))
      || !['defect', 'usage', 'requirement', 'duplicate'].includes(value.suggestedClassification)) return null;
    return value;
  } catch { return null; }
}
const originOf = (bug: BugRecord): ChatRef | undefined => bug.chatId ? { chatId: bug.chatId, rootId: bug.rootId } : undefined;
export function assertBugActor(ctx: DaemonContext, bug: BugRecord, actor: string | undefined): asserts actor is string {
  const owner = ctx.projects.find(project => project.alias === bug.project)?.owner;
  if (!actor || actor === 'unknown' || ![bug.requester, bug.owner, owner].filter(Boolean).includes(actor)) throw new Error('仅提出人、指派负责人或项目负责人可操作此 Bug');
}
function retainAttachments(id: string, files: string[]): string[] {
  return files.map((file, index) => {
    const dir = path.join(dataDir(), 'bugs', id, 'attachments', randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${index}-${path.basename(file)}`);
    fs.copyFileSync(file, target);
    return target;
  });
}

/** Explicit, evidence-bearing commands in the bound Bug thread. */
export function bugTextAction(bug: BugRecord, text: string): BugAction | 'start-fix' | 'investigate' | null {
  const line = text.replace(/^\/bug\s*/i, '').trim();
  const [verb, ...rest] = line.split(/\s+/);
  const body = rest.join(' ').trim();
  const evidenceRefs = body ? [body] : [];
  if (['调查', '重新调查', 'investigate'].includes(verb)) return 'investigate';
  if (['修复', '开始修复', 'start-fix'].includes(verb)) return 'start-fix';
  if (['缺陷', '确认缺陷'].includes(verb)) return { type: 'triage', reason: body || '人工确认：产品缺陷' };
  if (['使用问题', '新需求'].includes(verb)) return { type: 'reclassify', classification: verb === '使用问题' ? 'usage' : 'requirement',
    ...(verb === '新需求' && /^REQ-\d{3,}$/.test(rest[0] ?? '') ? { relatedRequirement: rest[0] } : {}), reason: body || `人工确认：${verb}` };
  if (verb === '重复' && rest[0]) return { type: 'duplicate', duplicateOf: rest[0], reason: rest.slice(1).join(' ') || '人工确认重复' };
  if (['复现', '定位', '未复现'].includes(verb) && body) return { type: 'reproduce', result: verb === '未复现' ? 'not-reproduced' : verb === '定位' ? 'located' : 'reproduced', evidenceRefs };
  if (verb === '修复完成' && rest.length >= 2 && bug.ticket) return { type: 'fix-ready', ticket: bug.ticket, fixVersion: rest[0], evidenceRefs: [rest.slice(1).join(' ')] };
  if (verb === '上线' && rest.length >= 2 && bug.fixVersion) return { type: 'deploy', fixVersion: bug.fixVersion, deployedVersion: rest[0], evidenceRefs: [rest.slice(1).join(' ')] };
  if (['通过', '失败'].includes(verb) && body && bug.fixVersion && bug.deployedVersion) return {
    type: verb === '通过' ? 'verify-pass' : 'verify-fail', round: bug.round, fixVersion: bug.fixVersion, deployedVersion: bug.deployedVersion, evidenceRefs, ...(verb === '失败' ? { reason: body } : {}),
  };
  if (verb === '重开' && body) return { type: 'reopen', reason: body };
  return null;
}

function requirementAction(bug: BugRecord, action: BugAction): BugAction {
  if (action.type !== 'reclassify' || action.classification !== 'requirement' || action.relatedRequirement) return action;
  if (bug.waitingForInfo) throw new Error('请先补充所需信息');
  if (!['待分诊', '待复现', '待修复'].includes(bug.status)) throw new Error('当前状态不能转需求');
  throw new Error('请先用 /req 创建需求，再在原Bug话题发送 /bug 新需求 REQ-001 理由，关联已经存在的需求');
}

const messageRequestId = (chatId: string, messageId: string) => `message-${createHash('sha256').update(`${chatId}\n${messageId}`).digest('hex')}`;
interface BugInitialization { attachments?: string[]; error?: string; }
const initializationFile = (id: string) => path.join(dataDir(), 'bug-initializations', `${id}.json`);
function initializationOf(id: string): BugInitialization {
  const file = initializationFile(id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as BugInitialization : {};
}
function saveInitialization(id: string, value: BugInitialization): void {
  fs.mkdirSync(path.dirname(initializationFile(id)), { recursive: true });
  writeOutputJson(initializationFile(id), value);
}
/** Registration is durable before any delivery. A repeat or restart resumes these steps. */
const initializing = new Map<string, Promise<BugRecord>>();
async function initializeBug(ctx: DaemonContext, original: BugRecord): Promise<BugRecord> {
  const previous = initializing.get(original.id);
  if (previous) return previous;
  const pending = initializeBugOnce(ctx, original);
  initializing.set(original.id, pending);
  try { return await pending; } finally { initializing.delete(original.id); }
}
async function initializeBugOnce(ctx: DaemonContext, original: BugRecord): Promise<BugRecord> {
  let bug = readBug(original.id)!;
  const initialization = initializationOf(bug.id);
  try {
    if (initialization.attachments?.length && !bug.history.some(entry => entry.action.requestId === `initial-attachments:${bug.id}`)) {
      const refs = retainAttachments(bug.id, initialization.attachments);
      bug = applyBugAction(bug.id, bug.revision, { type: 'supplement', raw: '原消息附件已持久保存', evidenceRefs: refs, requestId: `initial-attachments:${bug.id}` }, bug.requester);
    }
    if (!bug.rootId && bug.chatId) {
      const root = await ctx.port.openThread?.(bug.chatId, `🐞 ${bug.id} ${bug.raw.slice(0, 120)}\n问题、修复与验证在此话题继续。`);
      if (!root) throw new Error('Bug话题尚未建立，请稍后重试');
      const current = readBug(bug.id)!;
      bug = applyBugAction(current.id, current.revision, { type: 'bind-thread', chatId: bug.chatId, rootId: root }, 'system:bug');
    }
    if (bug.rootId && bug.chatId) bindBugThread(bug.rootId, bug.id, bug.chatId, bug.project);
    const requestId = `initial-${bug.id}`;
    if (!readBugRequest(requestId) && bug.status === '待分诊' && !bug.card) enqueueBugRequest({ id: bug.id, expectedRevision: bug.revision, requestId, by: bug.requester, operation: 'investigate' });
    saveInitialization(bug.id, {});
    return bug;
  } catch (error) {
    saveInitialization(bug.id, { ...initialization, error: (error as Error).message });
    throw error;
  }
}

export async function handleBug(ctx: DaemonContext, text: string, actor: string, chat?: ChatRef, metadata: { project?: string; messageId?: string; quotedMessageId?: string; reportedAt?: string; attachments?: string[] } = {}): Promise<void> {
  const chatId = chatIdOf(chat) ?? ctx.MAIN_CHAT;
  const rootId = rootIdOf(chat);
  if (metadata.messageId) {
    const previousRequest = readBugRequest(messageRequestId(chatId, metadata.messageId));
    if (previousRequest) {
      const previousBug = readBug(previousRequest.id);
      if (previousBug) { assertBugActor(ctx, previousBug, actor); await syncBugCard(ctx, previousBug); }
      return;
    }
    const duplicate = listBugs().find(item => item.chatId === chatId && (item.messageId === metadata.messageId || item.history.some(entry => entry.action.requestId === `message:${metadata.messageId}`)));
    if (duplicate) {
      assertBugActor(ctx, duplicate, actor);
      const current = duplicate.messageId === metadata.messageId ? await initializeBug(ctx, duplicate) : duplicate;
      await syncBugCard(ctx, current); return;
    }
  }
  let bug = rootId ? bugByThread(chatId, rootId) : null;
  const named = /^(BUG-\d{3,})\s+([\s\S]+)$/i.exec(text);
  if (named) {
    bug = readBug(named[1]); text = named[2];
    if (!bug || bug.chatId !== chatId || bug.rootId !== rootId) throw new Error('请在该 Bug 的原话题操作，或使用Web');
  }
  if (bug) {
    assertBugActor(ctx, bug, actor);
    if (metadata.quotedMessageId) {
      const quoted = storedBugCards().find(item => item.messageId === metadata.quotedMessageId);
      if (quoted && (quoted.chatId !== chatId || quoted.id !== bug.id || quoted.revision !== bug.revision || quoted.round !== bug.round
        || quoted.fixVersion !== bug.fixVersion || quoted.deployedVersion !== bug.deployedVersion)) throw new Error('引用的 Bug 卡片已过期，请使用最新版材料验证');
    }
    let action = bugTextAction(bug, text);
    if (action && typeof action !== 'string' && action.type === 'fix-ready' && bug.waitingForInfo) throw new Error('请先补充所需信息，再手工登记修复完成');
    if (action && typeof action !== 'string') action = requirementAction(bug, action);
    const attachmentRequestId = metadata.messageId ? `message:${metadata.messageId}:attachments` : undefined;
    const storedAttachments = attachmentRequestId ? bug.history.find(entry => entry.action.requestId === attachmentRequestId)?.action : undefined;
    const refs = storedAttachments && 'evidenceRefs' in storedAttachments ? storedAttachments.evidenceRefs ?? [] : retainAttachments(bug.id, metadata.attachments ?? []);
    if (refs.length && action && !storedAttachments) {
      bug = applyBugAction(bug.id, bug.revision, { type: 'supplement', raw: text, evidenceRefs: refs, ...(attachmentRequestId ? { requestId: attachmentRequestId } : {}) }, actor);
    }
    if (typeof action === 'string') enqueueBugRequest({ id: bug.id, expectedRevision: bug.revision, requestId: metadata.messageId ? messageRequestId(chatId, metadata.messageId) : randomUUID(), by: actor, operation: action });
    else {
      const complete = action ?? { type: 'supplement' as const, raw: text, evidenceRefs: [] };
      const withAttachments = 'evidenceRefs' in complete ? { ...complete, evidenceRefs: [...(complete.evidenceRefs ?? []), ...refs] } : complete;
      bug = applyBugAction(bug.id, bug.revision, { ...withAttachments, ...(metadata.messageId ? { requestId: `message:${metadata.messageId}` } : {}) }, actor);
      await syncBugCard(ctx, bug);
    }
    await ctx.port.notify(bug.id, `${bug.id} · ${bug.status}${typeof action === 'string' ? '，执行请求已排队' : ''}`, chat);
    return;
  }
  if (!actor || actor === 'unknown') throw new Error('Bug 登记需要明确操作者');
  const th = getThread(rootId);
  const explicit = resolveProject(ctx.projects, metadata.project ?? th?.project);
  const mentioned = mentionedProject(ctx.projects, text);
  let project = explicit ?? (mentioned?.exact ? mentioned.project : null) ?? ctx.projects.find(item => item.chatId === chatId) ?? (ctx.projects.length === 1 ? ctx.projects[0] : undefined);
  if (!project) {
    const selected = await ctx.port.chooseOption('Bug', '这个问题属于哪个项目？', ctx.projects.map(item => item.alias), chat, { allowed: [actor] });
    project = ctx.projects.find(item => item.alias === selected);
  }
  if (!project) return;
  const existing = metadata.messageId ? listBugs().find(item => item.messageId === metadata.messageId && item.chatId === chatId) : null;
  if (existing) { await syncBugCard(ctx, await initializeBug(ctx, existing)); return; }
  bug = createBug({ project: project.alias, repo: project.repo, requester: actor, raw: text, chatId,
    ...(rootId && !th?.ticket && !th?.req && !th?.bug ? { rootId } : {}), ...(metadata.messageId ? { messageId: metadata.messageId } : {}),
    ...(metadata.reportedAt ? { reportedAt: metadata.reportedAt } : {}), evidenceRefs: [] }, actor);
  saveInitialization(bug.id, { attachments: metadata.attachments ?? [] });
  bug = await initializeBug(ctx, bug);
  await ctx.port.notify(bug.id, '已保存原始反馈。先提炼实际、预期、影响与复现线索；分诊需人工确认。', originOf(bug));
  await syncBugCard(ctx, bug);
}

export async function investigateBug(ctx: DaemonContext, bug: BugRecord, actor: string): Promise<void> {
  const skill = path.join(PLUGIN_DIR, 'skills', 'pipeline-bug', 'SKILL.md');
  const release = await ctx.sem.acquire();
  try {
    const engine = engineFor(bug.repo, 'triage');
    if (engine.execution && /\b(Write|Edit|Bash|Agent|Task|NotebookEdit)\b/.test(engine.execution.tools)) throw new Error('调查入口不是只读工具集');
    const response = await engine.runText({ cwd: bug.repo, prompt: `${fs.readFileSync(skill, 'utf8')}\n仅只读调查，不修改代码，不发布部署，不自动确认分诊或复现。\n${JSON.stringify(bug)}`,
      tools: 'Read,Grep,Glob', model: engine.execution?.model ?? '', maxTurns: 8, budgetUsd: 2 });
    const analysis = parseBugAnalysis(response.text);
    if (!analysis) throw new Error('调查未返回有效bug-card');
    const current = readBug(bug.id);
    if (!current || current.revision !== bug.revision) throw new Error('调查期间Bug材料已变更，请基于最新材料重新调查');
    const next = applyBugAction(current.id, current.revision, { type: 'refine', card: analysis }, actor);
    await syncBugCard(ctx, next);
  } catch (error) {
    ctx.log(`${bug.id} 调查失败：${(error as Error).message}`);
    const current = readBug(bug.id);
    if (current?.revision === bug.revision) applyBugAction(current.id, current.revision, { type: 'need-info', reason: `本轮调查未完成：${(error as Error).message}。原话已保留；补充材料后可 /bug 调查 重试。` }, actor);
    throw error;
  } finally { release(); }
}

export async function startBugFix(ctx: DaemonContext, request: StoredBugRequest): Promise<void> {
  let bug = readBug(request.id);
  if (!bug) throw new Error('Bug 不存在');
  if (request.channel !== 'console') assertBugActor(ctx, bug, request.by);
  const token = `${bug.id}:${bug.round}:${request.requestId}`;
  // A replay after reservation must never start a second runner.
  if (bug.ticketAttempts.some(attempt => attempt.token === token)) return;
  const project = ctx.projects.find(item => item.alias === bug!.project);
  if (!project) throw new Error('Bug 项目不存在');
  const used = [...listTickets(), ...listBugs().flatMap(item => item.ticketAttempts.map(attempt => attempt.ticket))];
  const ticket = nextTicketId(project, used);
  bug = applyBugAction(bug.id, request.expectedRevision, { type: 'reserve-ticket', ticket, token, requestId: `reserve:${request.requestId}` }, request.by);
  const material = bug.card ? JSON.stringify(bug.card, null, 2) : bug.summary ?? bug.raw;
  try {
    const result = await ctx.startTicket(ticket, bug.project, `修复 ${bug.id}：${bug.title}\n${bug.raw}\n${material}`,
      `来自 ${bug.id}，第 ${bug.round} 轮；实际、预期、影响及复现证据：\n${material}\n${JSON.stringify(bug.reproduction)}\n用户补充：\n${bug.supplements.map(item => item.raw).join('\n')}\n原始附件与材料：\n${bug.evidenceRefs.join('\n')}\n修复工单完成只代表待上线；必须有部署版本和验证证据才能关闭Bug。`);
    if (!result.includes('已启动')) throw new Error(result);
    const current = readBug(bug.id)!;
    applyBugAction(current.id, current.revision, { type: 'link-ticket', ticket, token }, 'system:bug');
    const closed = [...readEvents(ticket)].reverse().find(isClosure);
    if (closed) await onBugTicketEvent(ctx, closed);
  } catch (error) {
    const current = readBug(bug.id)!;
    if (current.fixAttempt?.status === 'reserved') applyBugAction(current.id, current.revision, { type: 'ticket-start-failed', ticket, token, reason: (error as Error).message }, 'system:bug');
    throw error;
  }
  await syncBugCard(ctx, readBug(bug.id)!);
}

interface BugCardRecord { key: string; id: string; revision: number; round: number; fixVersion?: string; deployedVersion?: string; chatId: string; rootId?: string; messageId?: string; materialsSent?: boolean; actions: string[]; }
const cardDir = () => path.join(dataDir(), 'bug-cards');
const cardFile = (id: string, revision: number) => path.join(cardDir(), `${id}-${revision}.json`);
function storedBugCards(): BugCardRecord[] {
  const files = fs.existsSync(cardDir()) ? fs.readdirSync(cardDir()).filter(name => name.endsWith('.json')) : [];
  return files.map(name => JSON.parse(fs.readFileSync(path.join(cardDir(), name), 'utf8')) as BugCardRecord);
}
function cardActions(bug: BugRecord): Array<{ label: string; action: string }> {
  if (bug.status === '待分诊') return [{ label: '确认缺陷', action: 'triage' }, { label: '使用问题', action: 'usage' }, { label: '关联需求', action: 'requirement' }];
  if (bug.status === '待修复') return [{ label: '创建修复工单', action: 'start-fix' }];
  if (bug.status === '待验证') return [{ label: '验证通过（请附证据）', action: 'verify-pass' }, { label: '验证失败（请附原因）', action: 'verify-fail' }];
  if (bug.status === '待复现') return [{ label: '只读调查', action: 'investigate' }];
  return [];
}
export async function syncBugCard(ctx: DaemonContext, bug: BugRecord): Promise<void> {
  if (!bug.chatId || !ctx.port.sendBugCard) return;
  const file = cardFile(bug.id, bug.revision);
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as BugCardRecord : undefined;
  if (previous?.messageId && previous.materialsSent) return;
  fs.mkdirSync(cardDir(), { recursive: true });
  const actions = cardActions(bug);
  const record: BugCardRecord = previous ?? { key: randomUUID(), id: bug.id, revision: bug.revision, round: bug.round,
    fixVersion: bug.fixVersion, deployedVersion: bug.deployedVersion, chatId: bug.chatId, rootId: bug.rootId, actions: actions.map(item => item.action) };
  writeOutputJson(file, record);
  const instructions = bug.status === '待复现' ? '\n复现后：/bug 复现 <步骤、结果与证据>；定位后：/bug 定位 <代码位置与证据>'
    : bug.status === '待上线' ? '\n实际部署后：/bug 上线 <部署版本> <部署证据>'
    : bug.status === '待验证' ? '\n/bug 通过 <验证证据> 或 /bug 失败 <原因与证据>' : '';
  const material = bug.card ? `实际：${bug.card.actual}\n预期：${bug.card.expected}\n影响：${bug.card.impact}\n${bug.card.questions.length ? `待补充：${bug.card.questions.join('；')}` : '等待人工确认分诊/证据'}` : bug.summary ?? bug.raw;
  const initializationError = initializationOf(bug.id).error;
  const summary = `${bug.status} · 第${bug.round}轮 · 材料r${bug.revision}\n${bug.title}${bug.fixVersion ? `\n修复版本：${bug.fixVersion}` : ''}${bug.deployedVersion ? `\n部署版本：${bug.deployedVersion}` : ''}${instructions}${initializationError ? `\n初始化未完成：${initializationError}，服务恢复时会重试。` : ''}\n\n${material.slice(0, 900)}`;
  if (!record.messageId) {
    record.messageId = await ctx.port.sendBugCard(bugActionCard(bug.id, summary, record.key, actions), originOf(bug)!);
    writeOutputJson(file, record);
  }
  if (!record.materialsSent) {
    if (ctx.port.sendOutput) {
      const mid = await ctx.port.sendOutput({ repo: bug.repo, project: bug.project, stage: 'intake', title: `${bug.id} · 问题材料`, summary,
        detail: `原话：${bug.raw}\n\n${bug.card ? JSON.stringify(bug.card, null, 2) : bug.summary ?? '等待提炼或补充'}\n\n补充：\n${bug.supplements.map(item => item.raw).join('\n')}\n\n证据：\n${bug.evidenceRefs.join('\n')}`,
        risks: [...(bug.waitingForInfo ? [bug.waitingForInfo.reason] : []), ...(bug.card?.questions ?? [])], actions: [instructions.trim()].filter(Boolean), evidence: bug.evidenceRefs, materialRevision: bug.revision }, originOf(bug));
      if (!mid) return;
    }
    record.materialsSent = true;
    writeOutputJson(file, record);
  }
}
export async function handleBugCard(ctx: DaemonContext, value: CardAction, note: string | undefined, actor: string | undefined, source?: { chatId?: string; messageId?: string }): Promise<Record<string, unknown> | 'failed'> {
  try {
    const record = storedBugCards().find(item => item.key === value.key);
    if (!record || !source?.messageId || record.chatId !== source.chatId || record.messageId !== source.messageId || !record.actions.includes(value.answer ?? '')) throw new Error('Bug 卡片来源或动作不匹配');
    const bug = readBug(record.id);
    if (!bug || bug.revision !== record.revision || bug.round !== record.round || bug.fixVersion !== record.fixVersion || bug.deployedVersion !== record.deployedVersion) throw new Error('Bug 卡片已过期，请使用最新版');
    assertBugActor(ctx, bug, actor);
    if (value.answer === 'start-fix' || value.answer === 'investigate') enqueueBugRequest({ id: bug.id, expectedRevision: bug.revision, requestId: record.key, by: actor, operation: value.answer });
    else {
      let action: BugAction;
      if (value.answer === 'triage') action = { type: 'triage', reason: note || '人工确认：产品缺陷' };
      else if (value.answer === 'usage' || value.answer === 'requirement') action = { type: 'reclassify', classification: value.answer,
        ...(value.answer === 'requirement' && /^REQ-\d{3,}\b/.test(note ?? '') ? { relatedRequirement: note!.split(/\s+/)[0] } : {}), reason: note || '人工分诊确认' };
      else {
        if (!note) throw new Error('验证需附证据；请在原话题使用 /bug 通过 <证据> 或 /bug 失败 <原因与证据>');
        action = { type: value.answer as 'verify-pass' | 'verify-fail', round: record.round, fixVersion: record.fixVersion!, deployedVersion: record.deployedVersion!, evidenceRefs: [note], ...(value.answer === 'verify-fail' ? { reason: note } : {}) };
      }
      applyBugAction(bug.id, record.revision, { ...requirementAction(bug, action), requestId: record.key }, actor);
      await syncBugCard(ctx, readBug(bug.id)!);
    }
    return resolvedCard(`${bug.id} 已记录`, `${bug.status} · r${bug.revision}`, value.answer ?? '', note);
  } catch (error) {
    if (source?.chatId) await ctx.port.notify('Bug', (error as Error).message, source.chatId);
    return 'failed';
  }
}

export async function onBugTicketEvent(ctx: DaemonContext, event: PipelineEvent): Promise<void> {
  const bug = bugByTicket(event.ticket);
  if (!bug || bug.ticket !== event.ticket || bug.status !== '修复中' || bug.fixAttempt?.status !== 'linked' || !isClosure(event)) return;
  // Release/merge events alone are not evidence of a deployed version.
  const version = typeof event.payload?.fixVersion === 'string' ? event.payload.fixVersion : undefined;
  if (!version) {
    await ctx.port.notify(bug.id, `${event.ticket} 已完成修复工单。缺少已固定的修复版本，请在Web填写修复版本与证据；Bug保持修复中。`, originOf(bug));
    return;
  }
  const next = applyBugAction(bug.id, bug.revision, { type: 'fix-ready', ticket: event.ticket, fixVersion: version, evidenceRefs: [`ticket:${event.ticket}`, `event:${event.ts}:${event.summary}`] }, 'system:ticket');
  await syncBugCard(ctx, next);
}
export async function recoverBugs(ctx: DaemonContext): Promise<void> {
  for (let bug of listBugs()) {
    try {
      if (bug.messageId || fs.existsSync(initializationFile(bug.id))) bug = await initializeBug(ctx, bug);
      const attempt = bug.fixAttempt;
      if (attempt?.status === 'reserved') {
        const exists = listTickets().includes(attempt.ticket) || !!readSnapshot(attempt.ticket) || ctx.active.has(attempt.ticket);
        bug = applyBugAction(bug.id, bug.revision, exists ? { type: 'link-ticket', ticket: attempt.ticket, token: attempt.token }
          : { type: 'ticket-start-failed', ticket: attempt.ticket, token: attempt.token, reason: '服务重启中断建单；没有工单创建证据，请重新请求修复' }, 'system:recovery');
      }
      if (bug.rootId && bug.chatId) bindBugThread(bug.rootId, bug.id, bug.chatId, bug.project);
      if (bug.ticket) {
        const closed = [...readEvents(bug.ticket)].reverse().find(isClosure);
        if (closed) await onBugTicketEvent(ctx, closed);
      }
      await syncBugCard(ctx, readBug(bug.id)!);
    } catch (error) {
      const message = `${bug.id} 恢复未完成：${(error as Error).message}；其他Bug继续恢复。`;
      ctx.log(message);
      try { await ctx.port.notify(bug.id, message, originOf(bug)); await syncBugCard(ctx, readBug(bug.id)!); }
      catch (deliveryError) { ctx.log(`${bug.id} 恢复错误提示发送失败：${String(deliveryError)}`); }
    }
  }
}
export async function processBugRequests(ctx: DaemonContext): Promise<void> {
  for (const request of pendingBugRequests()) {
    try {
      const bug = readBug(request.id);
      if (!bug) throw new Error('Bug 不存在');
      if (request.channel !== 'console') assertBugActor(ctx, bug, request.by);
      if (request.operation === 'start-fix') await startBugFix(ctx, request);
      else {
        if (bug.revision !== request.expectedRevision) throw new Error('Bug 已变更，请重新请求调查');
        await investigateBug(ctx, bug, request.by);
      }
      acknowledgeBugRequest(request);
    } catch (error) {
      acknowledgeBugRequest(request, (error as Error).message);
      const bug = readBug(request.id);
      if (bug) await ctx.port.notify(bug.id, `执行请求未完成：${(error as Error).message}`, originOf(bug));
    }
  }
}
export function startBugTicker(ctx: DaemonContext): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processBugRequests(ctx);
      for (let bug of listBugs()) {
        if (bug.messageId && (!bug.rootId || initializationOf(bug.id).error)) {
          try { bug = await initializeBug(ctx, bug); }
          catch (error) { ctx.log(`${bug.id} 初始化重试未完成：${String(error)}`); }
        }
        if (bug.status === '修复中' && bug.ticket && bug.fixAttempt?.status === 'linked') {
          const closed = [...readEvents(bug.ticket)].reverse().find(isClosure);
          if (closed && closed.payload?.fixVersion) await onBugTicketEvent(ctx, closed);
        }
        await syncBugCard(ctx, readBug(bug.id)!);
      }
    }
    catch (error) { ctx.log(`Bug同步失败：${(error as Error).message}`); }
    finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), 10_000);
}
