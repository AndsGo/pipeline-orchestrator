import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBugAction, createBug, listBugs, readBug, type BugAction, type BugRecord } from '../bugs.js';
import { enqueueBugRequest, pendingBugRequests, readBugRequest } from '../daemon/bugMailbox.js';
import { bugTextAction, handleBug, handleBugCard, investigateBug, onBugTicketEvent, parseBugAnalysis, processBugRequests, recoverBugs, syncBugCard } from '../daemon/bugFlow.js';
import type { DaemonContext } from '../daemon/context.js';
import { engineFor } from '../engine/index.js';
import { appendEvent } from '../events.js';
import { createReq, listReqs } from '../requirements.js';
import { Semaphore } from '../semaphore.js';
import { isClearBugReport, parseSlash } from '../commands.js';
import { routeInThread } from '../threads.js';

vi.mock('../engine/index.js', () => ({ engineFor: vi.fn() }));
const previousData = process.env.PIPELINE_DATA_DIR;
let dir: string;
function context(): DaemonContext {
  let sequence = 0;
  const port = { notify: vi.fn(async () => {}), sendBugCard: vi.fn(async () => `card-${++sequence}`), sendOutput: vi.fn(async () => `output-${++sequence}`),
    openThread: vi.fn(async () => `root-${++sequence}`), chooseOption: vi.fn(async () => 'demo') };
  return { projects: [{ alias: 'demo', repo: dir, prefix: 'DM', owner: 'owner' }], MAIN_CHAT: 'chat', port, sem: new Semaphore(1), active: new Map(), log: vi.fn(),
    startTicket: vi.fn(async (ticket: string) => { appendEvent({ ticket, type: 'ticket.created', summary: '工单建立：修复Bug' }); return `${ticket} 已启动`; }) } as unknown as DaemonContext;
}
const change = (bug: BugRecord, action: BugAction) => applyBugAction(bug.id, bug.revision, action, 'reporter');
function fresh(): BugRecord { return createBug({ project: 'demo', repo: dir, requester: 'reporter', raw: '登录报500，预期进入首页', chatId: 'chat', rootId: 'root' }); }
function ready(): BugRecord { let bug = change(fresh(), { type: 'triage' }); return change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['trace://login-stack'] }); }
function card(bug: BugRecord) { return JSON.parse(fs.readFileSync(path.join(dir, 'bug-cards', `${bug.id}-${bug.revision}.json`), 'utf8')) as { key: string; messageId: string; revision: number }; }
function request(bug: BugRecord, requestId = 'request-0001') { return enqueueBugRequest({ id: bug.id, expectedRevision: bug.revision, requestId, by: 'reporter', operation: 'start-fix' }); }
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-runtime-')); process.env.PIPELINE_DATA_DIR = dir; vi.clearAllMocks(); });
afterEach(() => {
  if (previousData === undefined) delete process.env.PIPELINE_DATA_DIR; else process.env.PIPELINE_DATA_DIR = previousData;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Bug runtime lifecycle through durable Web requests and Feishu actions', () => {
  it('consumes duplicate requests once, freezes fix completion as pending deployment, and rejects prior rounds after reopening', async () => {
    let ctx = context();
    let bug = ready();
    const submitted = request(bug);
    expect(request(bug).createdAt).toBe(submitted.createdAt);
    await processBugRequests(ctx);
    await processBugRequests(ctx);
    expect(ctx.startTicket).toHaveBeenCalledTimes(1);
    expect(readBugRequest(submitted.requestId)?.completedAt).toBeTruthy();
    expect(pendingBugRequests()).toHaveLength(0);
    bug = readBug(bug.id)!;
    const ticket = bug.ticket!;
    expect(bug.status).toBe('修复中');
    const closure = appendEvent({ ticket, type: 'done', summary: '闭环：测试完成', payload: { fixVersion: 'commit-a' } });
    await onBugTicketEvent(ctx, closure);
    bug = readBug(bug.id)!;
    expect(bug.status).toBe('待上线');
    expect(bug.fixVersion).toBe('commit-a');
    expect(bug.deployedVersion).toBeUndefined();
    // A merge-only release is deliberately insufficient to attest a deployed version.
    await onBugTicketEvent(ctx, appendEvent({ ticket, type: 'release', summary: '已合并MR' }));
    expect(readBug(bug.id)!.status).toBe('待上线');
    bug = change(bug, { type: 'deploy', fixVersion: 'commit-a', deployedVersion: 'release-a', evidenceRefs: ['deploy://build-42'] });
    await syncBugCard(ctx, bug);
    const oldCard = card(bug);
    // Restart discards all process memory; the same persisted verification card remains usable.
    ctx = context();
    await recoverBugs(ctx);
    expect(await handleBugCard(ctx, { kind: 'bug', key: oldCard.key, answer: 'verify-pass' }, 'smoke://login passed release-a', 'reporter', { chatId: 'chat', messageId: oldCard.messageId })).not.toBe('failed');
    bug = readBug(bug.id)!;
    expect(bug.status).toBe('已关闭');
    bug = change(bug, { type: 'reopen', reason: '相同问题再次出现' });
    expect(bug.round).toBe(2);
    expect(bug.ticket).toBeUndefined();
    expect(await handleBugCard(ctx, { kind: 'bug', key: oldCard.key, answer: 'verify-pass' }, 'old evidence', 'reporter', { chatId: 'chat', messageId: oldCard.messageId })).toBe('failed');
    await onBugTicketEvent(ctx, closure);
    expect(readBug(bug.id)).toMatchObject({ round: 2, status: '待复现' });
    bug = change(readBug(bug.id)!, { type: 'reproduce', result: 'reproduced', evidenceRefs: ['trace://second'] });
    request(bug, 'request-0002');
    await processBugRequests(ctx);
    expect(readBug(bug.id)!.ticket).not.toBe(ticket);
    expect(readBug(bug.id)!.ticketAttempts).toHaveLength(2);
  });

  it('blocks same-revision duplicate clicks with different request IDs and records the loser', async () => {
    const ctx = context(); const bug = ready();
    request(bug, 'request-click-1'); request(bug, 'request-click-2');
    await processBugRequests(ctx);
    expect(ctx.startTicket).toHaveBeenCalledTimes(1);
    expect(readBugRequest('request-click-2')?.error).toMatch(/已变更|当前状态/);
  });

  it('reopens the same Bug on verification failure and refuses evidence from its previous card', async () => {
    const ctx = context(); let bug = ready(); request(bug); await processBugRequests(ctx); bug = readBug(bug.id)!;
    await onBugTicketEvent(ctx, appendEvent({ ticket: bug.ticket!, type: 'done', summary: '闭环', payload: { fixVersion: 'fix-a' } }));
    bug = change(readBug(bug.id)!, { type: 'deploy', fixVersion: 'fix-a', deployedVersion: 'deploy-a', evidenceRefs: ['deploy://a'] });
    await syncBugCard(ctx, bug); const previous = card(bug);
    await handleBug(ctx, '失败 同账户登录仍报500，见trace://failed', 'reporter', { chatId: 'chat', rootId: 'root' });
    expect(readBug(bug.id)).toMatchObject({ id: bug.id, status: '待复现', round: 2 });
    expect(listBugs()).toHaveLength(1);
    await expect(handleBug(ctx, '通过 previous smoke result', 'reporter', { chatId: 'chat', rootId: 'root' }, { quotedMessageId: previous.messageId })).rejects.toThrow('过期');
    expect(readBug(bug.id)!.round).toBe(2);
  });

  it('recovers a reserved existing ticket without starting another runner, then replays its closure', async () => {
    const ctx = context();
    let bug = change(ready(), { type: 'reserve-ticket', ticket: 'DM-001', token: 'interrupted' });
    appendEvent({ ticket: 'DM-001', type: 'ticket.created', summary: '工单建立：修复' });
    appendEvent({ ticket: 'DM-001', type: 'done', summary: '闭环', payload: { fixVersion: 'frozen-commit' } });
    await recoverBugs(ctx);
    bug = readBug(bug.id)!;
    expect(bug).toMatchObject({ status: '待上线', fixVersion: 'frozen-commit', fixAttempt: { status: 'linked' } });
    expect(ctx.startTicket).not.toHaveBeenCalled();
  });

  it('does not restart a reservation interrupted before any ticket was created', async () => {
    const ctx = context();
    const bug = change(ready(), { type: 'reserve-ticket', ticket: 'DM-001', token: 'before-start' });
    await recoverBugs(ctx);
    expect(readBug(bug.id)).toMatchObject({ status: '待修复', fixAttempt: { status: 'failed' } });
    expect(ctx.startTicket).not.toHaveBeenCalled();
  });

  it('requires a known Feishu actor and exact source message before accepting an action', async () => {
    const ctx = context(); const bug = fresh(); await syncBugCard(ctx, bug);
    const current = card(bug);
    for (const [actor, chatId, messageId] of [[undefined, 'chat', current.messageId], ['stranger', 'chat', current.messageId], ['reporter', 'other', current.messageId], ['reporter', 'chat', 'copied-message']] as const) {
      expect(await handleBugCard(ctx, { kind: 'bug', key: current.key, answer: 'triage' }, undefined, actor, { chatId, messageId })).toBe('failed');
    }
    expect(readBug(bug.id)!.revision).toBe(bug.revision);
    expect(await handleBugCard(ctx, { kind: 'bug', key: current.key, answer: 'triage' }, undefined, 'owner', { chatId: 'chat', messageId: current.messageId })).not.toBe('failed');
    expect(readBug(bug.id)!.status).toBe('待复现');
  });

  it('accepts trusted console requests while rejecting untrusted actor labels', async () => {
    const ctx = context(); const bug = ready();
    enqueueBugRequest({ id: bug.id, expectedRevision: bug.revision, requestId: 'console-request', by: '控制台', channel: 'console', operation: 'start-fix' });
    await processBugRequests(ctx); expect(ctx.startTicket).toHaveBeenCalledTimes(1);
    const next = ready();
    enqueueBugRequest({ id: next.id, expectedRevision: next.revision, requestId: 'forged-request', by: '控制台', operation: 'start-fix' });
    await processBugRequests(ctx); expect(ctx.startTicket).toHaveBeenCalledTimes(1);
    expect(readBugRequest('forged-request')?.error).toMatch(/仅提出人/);
  });

  it('persists model failure as a queue error and preserves raw input awaiting more information', async () => {
    const ctx = context(); const bug = fresh();
    vi.mocked(engineFor).mockImplementation(() => { throw new Error('model unavailable'); });
    enqueueBugRequest({ id: bug.id, expectedRevision: bug.revision, requestId: 'analysis-failed', by: 'reporter', operation: 'investigate' });
    await processBugRequests(ctx);
    expect(readBugRequest('analysis-failed')?.error).toBe('model unavailable');
    expect(readBug(bug.id)).toMatchObject({ raw: bug.raw, status: '待分诊', waitingForInfo: { actor: 'reporter' } });
    expect(ctx.sem.inUse).toBe(0);
  });

  it('refines actual/expected/impact via the read-only triage entry without confirming a hypothesis', async () => {
    const ctx = context(); const bug = fresh();
    const analysis = { title: '登录失败', actual: '500', expected: '首页', impact: '用户不能登录', reproductionSteps: ['点击登录'], suggestedClassification: 'defect', analysis: '需核验日志', questions: ['影响多少用户？'], evidenceRefs: ['model://guess'] };
    vi.mocked(engineFor).mockReturnValue({ runText: vi.fn(async () => ({ text: `\`\`\`bug-card\n${JSON.stringify(analysis)}\n\`\`\``, costUsd: 0, turns: 1, isError: false })) } as never);
    await investigateBug(ctx, bug, 'reporter');
    expect(engineFor).toHaveBeenCalledWith(dir, 'triage');
    expect(readBug(bug.id)).toMatchObject({ title: '登录失败', status: '待分诊', card: analysis });
    expect(readBug(bug.id)!.reproduction).toBeUndefined();
    expect(readBug(bug.id)!.evidenceRefs).not.toContain('model://guess');
    expect(ctx.port.sendOutput).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining('实际：500') }), expect.anything());
  });

  it('keeps attachments beyond transient cleanup and deduplicates the original message', async () => {
    const ctx = context(); const attachment = path.join(dir, 'screen.png'); fs.writeFileSync(attachment, 'picture');
    const metadata = { messageId: 'original-message', attachments: [attachment], reportedAt: '2026-11-17T01:00:00Z' };
    await handleBug(ctx, '登录报错', 'reporter', 'chat', metadata);
    await handleBug(ctx, '登录报错', 'reporter', 'chat', metadata);
    const bugs = listBugs(); expect(bugs).toHaveLength(1);
    expect(pendingBugRequests()).toHaveLength(1);
    expect(bugs[0].reportedAt).toBe(metadata.reportedAt);
    fs.unlinkSync(attachment);
    expect(fs.readFileSync(bugs[0].evidenceRefs[0], 'utf8')).toBe('picture');
  });

  it('associates the explicit new-requirement decision with an existing requirement', async () => {
    const ctx = context(); const bug = fresh();
    const req = createReq({ project: 'demo', requester: 'reporter', raw: '产品能力尚未实现', chatId: 'chat', rootId: 'req-root' });
    await handleBug(ctx, `新需求 ${req.id} 产品能力尚未实现`, 'reporter', { chatId: 'chat', rootId: 'root' });
    const updated = readBug(bug.id)!;
    expect(updated.status).toBe('已转需求');
    expect(listReqs().map(req => req.id)).toContain(updated.relatedRequirement);
    expect(listReqs()).toHaveLength(1);
    expect(ctx.port.openThread).not.toHaveBeenCalled();
  });

  it('rejects missing requirement associations without creating records or external threads', async () => {
    const ctx = context(); const bug = fresh();
    await expect(handleBug(ctx, '新需求 产品能力尚未实现', 'reporter', { chatId: 'chat', rootId: 'root' })).rejects.toThrow('/req');
    const waiting = change(bug, { type: 'need-info', reason: '请补充使用背景' });
    await expect(handleBug(ctx, '新需求 尚未实现', 'reporter', { chatId: 'chat', rootId: 'root' })).rejects.toThrow('请先补充');
    await syncBugCard(ctx, waiting); const current = card(waiting);
    expect(await handleBugCard(ctx, { kind: 'bug', key: current.key, answer: 'requirement' }, undefined, 'reporter', { chatId: 'chat', messageId: current.messageId })).toBe('failed');
    expect(readBug(bug.id)!.revision).toBe(waiting.revision);
    expect(listReqs()).toHaveLength(0);
    expect(ctx.port.openThread).not.toHaveBeenCalled();
  });

  it('resumes registration after a thread failure, retaining evidence and scheduling initial investigation once', async () => {
    const ctx = context(); vi.mocked(ctx.port.openThread!).mockRejectedValueOnce(new Error('network failure'));
    const attachment = path.join(dir, 'original.png'); fs.writeFileSync(attachment, 'original evidence');
    const metadata = { messageId: 'failed-registration', attachments: [attachment] };
    await expect(handleBug(ctx, '登录报错', 'reporter', 'chat', metadata)).rejects.toThrow('network failure');
    const bug = listBugs()[0];
    expect(bug.rootId).toBeUndefined();
    expect(fs.readFileSync(bug.evidenceRefs[0], 'utf8')).toBe('original evidence');
    fs.unlinkSync(attachment);
    await handleBug(ctx, '登录报错', 'reporter', 'chat', metadata);
    await recoverBugs(context());
    await handleBug(ctx, '登录报错', 'reporter', 'chat', metadata);
    expect(listBugs()).toHaveLength(1);
    expect(readBug(bug.id)!.rootId).toBeTruthy();
    expect(pendingBugRequests().filter(request => request.operation === 'investigate')).toHaveLength(1);
    expect(ctx.port.openThread).toHaveBeenCalledTimes(2);
    expect(readBug(bug.id)!.evidenceRefs).toHaveLength(1);
  });

  it('recovers registration without receiving the original message again, and isolates another failed registration', async () => {
    const ctx = context();
    const repair = change(ready(), { type: 'reserve-ticket', ticket: 'DM-001', token: 'recovery-info' });
    change(repair, { type: 'need-info', reason: '补充业务背景' });
    appendEvent({ ticket: 'DM-001', type: 'ticket.created', summary: 'created' });
    const broken = createBug({ project: 'demo', repo: dir, requester: 'reporter', raw: 'rootless', chatId: 'chat', messageId: 'rootless-message' });
    vi.mocked(ctx.port.openThread!).mockRejectedValueOnce(new Error('network unavailable'));
    await expect(recoverBugs(ctx)).resolves.toBeUndefined();
    expect(readBug(repair.id)?.fixAttempt?.status).toBe('linked');
    expect(readBug(repair.id)?.waitingForInfo).toBeTruthy();
    expect(readBug(broken.id)?.rootId).toBeUndefined();
    expect(ctx.port.notify).toHaveBeenCalledWith(broken.id, expect.stringContaining('恢复未完成'), expect.anything());
    await recoverBugs(ctx);
    expect(readBug(broken.id)?.rootId).toBeTruthy();
    expect(pendingBugRequests().filter(request => request.id === broken.id)).toHaveLength(1);
  });

  it('links a started runner even when info is requested while its reservation is pending', async () => {
    const ctx = context(); const bug = ready();
    vi.mocked(ctx.startTicket).mockImplementation(async ticket => {
      appendEvent({ ticket, type: 'ticket.created', summary: 'created' });
      change(readBug(bug.id)!, { type: 'need-info', reason: '补充业务背景' });
      return `${ticket} 已启动`;
    });
    await handleBug(ctx, '修复', 'reporter', { chatId: 'chat', rootId: 'root' }, { messageId: 'reserved-message' });
    await processBugRequests(ctx);
    expect(readBug(bug.id)?.fixAttempt?.status).toBe('linked');
    await expect(recoverBugs(ctx)).resolves.toBeUndefined();
    expect(readBug(bug.id)?.waitingForInfo).toBeTruthy();
    expect(ctx.startTicket).toHaveBeenCalledTimes(1);
  });

  it('blocks manual fix completion while awaiting information but still records system closure facts', async () => {
    const ctx = context(); const initial = ready(); request(initial); await processBugRequests(ctx);
    const bug = change(readBug(initial.id)!, { type: 'need-info', reason: '等待业务背景' });
    await expect(handleBug(ctx, '修复完成 manual-version test://manual', 'reporter', { chatId: 'chat', rootId: 'root' }, { messageId: 'manual-fix-waiting' })).rejects.toThrow('请先补充');
    expect(readBug(bug.id)).toMatchObject({ revision: bug.revision, status: '修复中', waitingForInfo: { reason: '等待业务背景' } });
    await onBugTicketEvent(ctx, appendEvent({ ticket: bug.ticket!, type: 'done', summary: '闭环', payload: { fixVersion: 'system-commit' } }));
    expect(readBug(bug.id)).toMatchObject({ status: '待上线', fixVersion: 'system-commit', waitingForInfo: { reason: '等待业务背景' } });
  });

  it('never reuses an old repair message to start a runner in a later Bug round', async () => {
    const ctx = context(); let bug = ready();
    const metadata = { messageId: 'repair-original-message' };
    await handleBug(ctx, '修复', 'reporter', { chatId: 'chat', rootId: 'root' }, metadata);
    await processBugRequests(ctx); bug = readBug(bug.id)!;
    bug = change(bug, { type: 'fix-ready', ticket: bug.ticket!, fixVersion: 'a', evidenceRefs: ['fix://a'] });
    bug = change(bug, { type: 'deploy', fixVersion: 'a', deployedVersion: 'a', evidenceRefs: ['deploy://a'] });
    bug = change(bug, { type: 'verify-fail', round: bug.round, fixVersion: 'a', deployedVersion: 'a', evidenceRefs: ['verify://a'], reason: 'still fails' });
    bug = change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['trace://b'] });
    await handleBug(ctx, '修复', 'reporter', { chatId: 'chat', rootId: 'root' }, metadata);
    await processBugRequests(ctx);
    expect(ctx.startTicket).toHaveBeenCalledTimes(1);
    expect(readBug(bug.id)).toMatchObject({ round: 2, status: '待修复' });
    expect(readBug(bug.id)!.ticketAttempts).toHaveLength(1);
  });

  it('does not rerun an acknowledged investigation when its message is replayed after new material', async () => {
    const ctx = context(); const bug = fresh();
    const analysis = { title: '登录失败', actual: '500', expected: '首页', impact: '不能登录', reproductionSteps: [], suggestedClassification: 'defect', analysis: '待核实', questions: [], evidenceRefs: [] };
    const runText = vi.fn(async () => ({ text: `\`\`\`bug-card\n${JSON.stringify(analysis)}\n\`\`\``, costUsd: 0, turns: 1, isError: false }));
    vi.mocked(engineFor).mockReturnValue({ runText } as never);
    const metadata = { messageId: 'investigation-original-message' };
    await handleBug(ctx, '调查', 'reporter', { chatId: 'chat', rootId: 'root' }, metadata);
    await processBugRequests(ctx);
    change(readBug(bug.id)!, { type: 'supplement', raw: '另一个账户也受影响' });
    await handleBug(ctx, '调查', 'reporter', { chatId: 'chat', rootId: 'root' }, metadata);
    await processBugRequests(ctx);
    expect(runText).toHaveBeenCalledTimes(1);
  });

  it('associates attachments with evidence-bearing actions and keeps other original message attachments', async () => {
    const ctx = context(); let bug = fresh();
    const file = path.join(dir, 'screenshot.png'); fs.writeFileSync(file, 'evidence');
    await handleBug(ctx, '缺陷', 'reporter', { chatId: 'chat', rootId: 'root' }, { messageId: 'triage-picture', attachments: [file] });
    bug = readBug(bug.id)!;
    expect(bug.status).toBe('待复现');
    expect(bug.supplements[0].evidenceRefs).toHaveLength(1);
    await handleBug(ctx, '复现 登录仍报500', 'reporter', { chatId: 'chat', rootId: 'root' }, { messageId: 'reproduction-picture', attachments: [file] });
    bug = readBug(bug.id)!;
    expect(bug.reproduction!.evidenceRefs).toHaveLength(2);
    const saved = bug.reproduction!.evidenceRefs.find(ref => ref !== '登录仍报500')!;
    fs.unlinkSync(file);
    expect(fs.readFileSync(saved, 'utf8')).toBe('evidence');
    const revision = bug.revision;
    await handleBug(ctx, '复现 登录仍报500', 'reporter', { chatId: 'chat', rootId: 'root' }, { messageId: 'reproduction-picture', attachments: [file] });
    expect(readBug(bug.id)!.revision).toBe(revision);
  });

  it('retries unsent materials without duplicating the operation card', async () => {
    const ctx = context(); const bug = fresh();
    vi.mocked(ctx.port.sendOutput!).mockRejectedValueOnce(new Error('delivery unavailable'));
    await expect(syncBugCard(ctx, bug)).rejects.toThrow('delivery unavailable');
    await syncBugCard(ctx, bug);
    expect(ctx.port.sendBugCard).toHaveBeenCalledTimes(1);
    expect(ctx.port.sendOutput).toHaveBeenCalledTimes(2);
  });

  it('routes concrete reports and bound Bug supplements without changing explicit run commands', () => {
    expect(parseSlash('/bug 登录报500')).toEqual({ kind: 'bug', text: '登录报500' });
    expect(parseSlash('/run 分析登录报500')).toEqual({ kind: 'run', text: '分析登录报500' });
    expect(isClearBugReport('打开页面后一直报错')).toBe(true);
    expect(isClearBugReport('如果登录报错如何处理')).toBe(false);
    expect(routeInThread({ kind: 'unknown', text: '只有管理员受影响' }, { bug: 'BUG-001', project: 'demo' } as never, '只有管理员受影响', false)).toEqual({ kind: 'bug', project: 'demo', text: '只有管理员受影响' });
    expect(bugTextAction({ fixVersion: 'a', deployedVersion: 'b', round: 2 } as BugRecord, '失败 登录仍报500')).toMatchObject({ type: 'verify-fail', round: 2, fixVersion: 'a', deployedVersion: 'b', reason: '登录仍报500' });
    expect(parseBugAnalysis('invalid')).toBeNull();
  });
});
