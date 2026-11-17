import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyBugAction, createBug, listBugs, readBug, type BugAction, type BugRecord } from '../bugs.js';
import { handleBug, processBugRequests, recoverBugs } from '../daemon/bugFlow.js';
import { pendingBugRequests } from '../daemon/bugMailbox.js';
import { listReqs } from '../requirements.js';
import { appendEvent } from '../events.js';
import { Semaphore } from '../semaphore.js';
import type { DaemonContext } from '../daemon/context.js';

let dir: string;
const original = process.env.PIPELINE_DATA_DIR;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bug-audit-')); process.env.PIPELINE_DATA_DIR = dir; });
afterEach(() => { if (original === undefined) delete process.env.PIPELINE_DATA_DIR; else process.env.PIPELINE_DATA_DIR = original; fs.rmSync(dir, { recursive: true, force: true }); });
function ctx(): DaemonContext {
  return { projects: [{ alias: 'demo', repo: dir, prefix: 'DM', owner: 'owner' }], MAIN_CHAT: 'chat', sem: new Semaphore(1), active: new Map(), log: vi.fn(),
    port: { notify: vi.fn(async () => {}), openThread: vi.fn(async () => 'new-root') },
    startTicket: vi.fn(async (ticket: string) => { appendEvent({ ticket, type: 'ticket.created', summary: 'created' }); return `${ticket} 已启动`; }) } as unknown as DaemonContext;
}
const change = (b: BugRecord, a: BugAction) => applyBugAction(b.id, b.revision, a, 'reporter');
function fresh() { return createBug({ project: 'demo', repo: dir, requester: 'reporter', raw: 'actual failure', chatId: 'chat', rootId: 'root' }); }
function ready() { return change(change(fresh(), { type: 'triage' }), { type: 'reproduce', result: 'located', evidenceRefs: ['trace://a'] }); }
const chat = { chatId: 'chat', rootId: 'root' };

it('rejects requirement conversion without creating a requirement or external thread', async () => {
  const c = ctx(); const b = change(fresh(), { type: 'need-info', reason: 'need details' });
  await expect(handleBug(c, '新需求 尚未实现', 'reporter', chat)).rejects.toThrow('请先补充');
  expect(readBug(b.id)?.relatedRequirement).toBeUndefined();
  expect(listReqs()).toHaveLength(0);
  expect(c.port.openThread).not.toHaveBeenCalled();
});

it('resumes registration after thread delivery failure and queues initial investigation once', async () => {
  const c = ctx(); vi.mocked(c.port.openThread!).mockRejectedValueOnce(new Error('network failure'));
  await expect(handleBug(c, '登录报错', 'reporter', 'chat', { messageId: 'origin-1' })).rejects.toThrow('network failure');
  await handleBug(c, '登录报错', 'reporter', 'chat', { messageId: 'origin-1' });
  await recoverBugs(c);
  expect(listBugs()).toHaveLength(1);
  expect(listBugs()[0].rootId).toBe('new-root');
  expect(pendingBugRequests()).toHaveLength(1);
  expect(pendingBugRequests()[0].requestId).toBe(`initial-${listBugs()[0].id}`);
  expect(c.port.openThread).toHaveBeenCalledTimes(2);
});

it('links started repair work and recovers while preserving the request for more information', async () => {
  const c = ctx(); const b = ready();
  vi.mocked(c.startTicket).mockImplementation(async ticket => {
    appendEvent({ ticket, type: 'ticket.created', summary: 'created' });
    change(readBug(b.id)!, { type: 'need-info', reason: 'need business details' });
    return `${ticket} 已启动`;
  });
  await handleBug(c, '修复', 'reporter', chat, { messageId: 'repair-1' });
  await processBugRequests(c);
  expect(readBug(b.id)?.fixAttempt?.status).toBe('linked');
  await expect(recoverBugs(c)).resolves.toBeUndefined();
  expect(readBug(b.id)?.waitingForInfo?.reason).toBe('need business details');
  expect(c.startTicket).toHaveBeenCalledTimes(1);
});

it('rejects replayed repair messages across rounds and accepts a new repair request', async () => {
  const c = ctx(); let b = ready();
  await handleBug(c, '修复', 'reporter', chat, { messageId: 'repair-old' }); await processBugRequests(c);
  b = readBug(b.id)!;
  b = change(b, { type: 'fix-ready', ticket: b.ticket!, fixVersion: 'a', evidenceRefs: ['fix://a'] });
  b = change(b, { type: 'deploy', fixVersion: 'a', deployedVersion: 'a', evidenceRefs: ['deploy://a'] });
  b = change(b, { type: 'verify-fail', round: b.round, fixVersion: 'a', deployedVersion: 'a', evidenceRefs: ['verify://a'], reason: 'still fails' });
  b = change(b, { type: 'reproduce', result: 'located', evidenceRefs: ['trace://b'] });
  await handleBug(c, '修复', 'reporter', chat, { messageId: 'repair-old' }); await processBugRequests(c);
  expect(c.startTicket).toHaveBeenCalledTimes(1);
  expect(readBug(b.id)).toMatchObject({ status: '待修复', round: 2 });
  expect(readBug(b.id)?.ticketAttempts).toHaveLength(1);
  await handleBug(c, '修复', 'reporter', chat, { messageId: 'repair-new' }); await processBugRequests(c);
  expect(c.startTicket).toHaveBeenCalledTimes(2);
  expect(readBug(b.id)?.ticketAttempts).toHaveLength(2);
});

it('retains and links command attachments once beyond transient source cleanup', async () => {
  const c = ctx(); const b = change(fresh(), { type: 'triage' });
  const file = path.join(dir, 'screenshot.png'); fs.writeFileSync(file, 'evidence');
  await handleBug(c, '复现 登录失败，见附件', 'reporter', chat, { messageId: 'reproduce-1', attachments: [file] });
  const current = readBug(b.id)!;
  const retained = current.evidenceRefs.find(ref => ref.startsWith(path.join(dir, 'bugs', b.id, 'attachments')))!;
  expect(retained).toBeTruthy();
  expect(current.reproduction?.evidenceRefs).toContain(retained);
  expect(current.supplements).toHaveLength(1);
  fs.unlinkSync(file);
  expect(fs.readFileSync(retained, 'utf8')).toBe('evidence');
  await handleBug(c, '复现 登录失败，见附件', 'reporter', chat, { messageId: 'reproduce-1', attachments: [file] });
  expect(readBug(b.id)?.revision).toBe(current.revision);
});

it('blocks manual Feishu fix completion while waiting for information, matching Web', async () => {
  const c = ctx(); let b = ready();
  await handleBug(c, '修复', 'reporter', chat, { messageId: 'repair-awaiting-details' }); await processBugRequests(c);
  b = change(readBug(b.id)!, { type: 'need-info', reason: 'need business details' });
  await expect(handleBug(c, '修复完成 commit-a test://passed', 'reporter', chat, { messageId: 'manual-completion' })).rejects.toThrow('请先补充');
  expect(readBug(b.id)).toMatchObject({ status: '修复中', revision: b.revision });
});
