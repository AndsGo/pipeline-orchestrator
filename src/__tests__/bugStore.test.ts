import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBugAction, bugByThread, bugByTicket, BugConflictError, BugStoreError, createBug, listBugs, readBug, type BugAction, type BugRecord } from '../bugs.js';
import { createReq } from '../requirements.js';

const previousData = process.env.PIPELINE_DATA_DIR;
let dir: string;
const input = () => ({ project: 'demo', repo: path.resolve('.'), requester: 'reporter', raw: '原始描述\n第二行', chatId: 'chat', rootId: 'root', messageId: 'message', evidenceRefs: ['attachment://original'] });
const change = (bug: BugRecord, action: BugAction): BugRecord => applyBugAction(bug.id, bug.revision, action, 'operator');
function repairing(): BugRecord {
  let bug = createBug(input());
  bug = change(bug, { type: 'triage' });
  bug = change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['log://trace'] });
  bug = change(bug, { type: 'reserve-ticket', ticket: 'DEMO-001', token: 'request-1' });
  return change(bug, { type: 'link-ticket', ticket: 'DEMO-001', token: 'request-1' });
}
function awaitingVerification(): BugRecord {
  let bug = repairing();
  bug = change(bug, { type: 'fix-ready', ticket: 'DEMO-001', fixVersion: 'commit-1', evidenceRefs: ['test://passed'] });
  return change(bug, { type: 'deploy', fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: ['deployment://release-1'] });
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-bugs-')); process.env.PIPELINE_DATA_DIR = dir; });
afterEach(() => {
  if (previousData === undefined) delete process.env.PIPELINE_DATA_DIR; else process.env.PIPELINE_DATA_DIR = previousData;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('independent Bug lifecycle store', () => {
  it('preserves original input and attachments, and retries registration without duplicate Bugs', () => {
    const bug = createBug({ ...input(), requestId: 'web-1' });
    expect(bug.id).toBe('BUG-001');
    expect(createBug({ ...input(), requestId: 'web-1' }).id).toBe(bug.id);
    expect(createBug(input()).id).toBe(bug.id);
    expect(() => createBug({ ...input(), raw: 'changed' })).toThrow(BugConflictError);
    expect(() => createBug({ ...input(), title: 'changed' })).toThrow(BugConflictError);
    expect(() => createBug({ ...input(), requester: 'other' })).toThrow(BugConflictError);
    expect(() => createBug({ ...input(), evidenceRefs: ['attachment://other'] })).toThrow(BugConflictError);
    const updated = change(bug, { type: 'update', summary: '提炼摘要', severity: 'S1', priority: 'P3' });
    expect(updated).toMatchObject({ raw: input().raw, summary: '提炼摘要', severity: 'S1', priority: 'P3', evidenceRefs: ['attachment://original'] });
    expect(bugByThread('chat', 'root')?.id).toBe(bug.id);
    expect(readBug('../outside')).toBeNull();
    expect(listBugs()).toHaveLength(1);
  });

  it('stores structured analysis separately from the original and binds a newly opened thread once', () => {
    let bug = createBug({ ...input(), chatId: undefined, rootId: undefined, reportedAt: '2026-11-17T00:00:00Z' });
    bug = change(bug, { type: 'refine', card: { title: '导出失败', actual: '导出按钮无响应', expected: '下载文件', impact: '无法完成报表', reproductionSteps: ['点击导出'], analysis: '需要检查导出请求', questions: ['是否所有账户受影响？'], suggestedClassification: 'defect', evidenceRefs: ['model://hypothesis'] } });
    expect(bug.title).toBe('导出失败');
    expect(bug.raw).toBe(input().raw);
    expect(bug.status).toBe('待分诊');
    expect(bug.reproduction).toBeUndefined();
    expect(bug.evidenceRefs).not.toContain('model://hypothesis');
    bug = change(bug, { type: 'bind-thread', chatId: 'new-chat', rootId: 'new-root' });
    expect(change(bug, { type: 'bind-thread', chatId: 'new-chat', rootId: 'new-root' }).revision).toBe(bug.revision);
    expect(() => change(bug, { type: 'bind-thread', chatId: 'new-chat', rootId: 'different' })).toThrow(BugConflictError);
    expect(bug.reportedAt).toBe('2026-11-17T00:00:00Z');
  });

  it('keeps the current phase while waiting for supplemental information', () => {
    let bug = change(createBug(input()), { type: 'triage' });
    bug = change(bug, { type: 'need-info', reason: '请提供日志' });
    expect(bug.status).toBe('待复现');
    expect(() => change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['log://trace'] })).toThrow('先补充');
    bug = change(bug, { type: 'supplement', raw: '补充原话', evidenceRefs: ['attachment://log'] });
    expect(bug.status).toBe('待复现');
    expect(bug.waitingForInfo).toBeUndefined();
    expect(bug.raw).toBe(input().raw);
    expect(bug.supplements[0]).toMatchObject({ raw: '补充原话', actor: 'operator' });
    expect(bug.history.map(entry => entry.revision)).toEqual([1, 2, 3, 4]);
  });

  it('requires reproduction or code/log/test evidence before reserving repair work', () => {
    let bug = createBug(input());
    expect(() => change(bug, { type: 'reserve-ticket', ticket: 'DEMO-001', token: 'request-1' })).toThrow(BugStoreError);
    bug = change(bug, { type: 'triage' });
    expect(() => change(bug, { type: 'reproduce', result: 'located', evidenceRefs: [] })).toThrow('证据');
    bug = change(bug, { type: 'reproduce', result: 'not-reproduced', evidenceRefs: ['log://inconclusive'] });
    expect(bug.status).toBe('待复现');
    bug = change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['code://line-10'] });
    expect(bug.status).toBe('待修复');
  });

  it('persists a reservation across reloads and rejects concurrent ticket reuse across Bugs', () => {
    const bug = repairing();
    expect(readBug(bug.id)?.fixAttempt).toMatchObject({ ticket: 'DEMO-001', status: 'linked', round: 1 });
    expect(bugByTicket('DEMO-001')?.id).toBe(bug.id);
    let other = createBug({ ...input(), messageId: 'other' });
    other = change(other, { type: 'triage' });
    other = change(other, { type: 'reproduce', result: 'reproduced', evidenceRefs: ['test://repro'] });
    expect(() => change(other, { type: 'reserve-ticket', ticket: 'DEMO-001', token: 'request-2' })).toThrow(BugConflictError);
  });

  it('records failed starts and requires a fresh reservation token to retry', () => {
    let bug = change(createBug(input()), { type: 'triage' });
    bug = change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['test://repro'] });
    bug = change(bug, { type: 'reserve-ticket', ticket: 'DEMO-001', token: 'request-1' });
    bug = change(bug, { type: 'ticket-start-failed', ticket: 'DEMO-001', token: 'request-1', reason: '进程退出' });
    expect(bug.status).toBe('待修复');
    expect(() => change(bug, { type: 'reserve-ticket', ticket: 'DEMO-002', token: 'request-1' })).toThrow(BugConflictError);
    bug = change(bug, { type: 'reserve-ticket', ticket: 'DEMO-002', token: 'request-2' });
    expect(bug.ticketAttempts.map(attempt => attempt.status)).toEqual(['failed', 'reserved']);
  });

  it.each(['link-ticket', 'ticket-start-failed'] as const)('settles %s while waiting for information without losing the wait', type => {
    let bug = change(createBug(input()), { type: 'triage' });
    bug = change(bug, { type: 'reproduce', result: 'located', evidenceRefs: ['test://repro'] });
    bug = change(bug, { type: 'reserve-ticket', ticket: 'DEMO-001', token: 'request-1' });
    bug = change(bug, { type: 'need-info', reason: '请确认业务影响' });
    const waiting = bug.waitingForInfo;
    bug = change(bug, type === 'link-ticket'
      ? { type, ticket: 'DEMO-001', token: 'request-1' }
      : { type, ticket: 'DEMO-001', token: 'request-1', reason: '启动失败' });
    expect(bug.waitingForInfo).toEqual(waiting);
    expect(readBug(bug.id)?.fixAttempt?.status).toBe(type === 'link-ticket' ? 'linked' : 'failed');
    expect(bug.status).toBe(type === 'link-ticket' ? '修复中' : '待修复');
    expect(bug.ticketAttempts[0].status).toBe(bug.fixAttempt?.status);
    if (type === 'ticket-start-failed') expect(() => change(bug, { type: 'reserve-ticket', ticket: 'DEMO-002', token: 'request-2' })).toThrow('先补充');
  });

  it('records completed repair facts while waiting, and requires supplementation before deployment', () => {
    let bug = change(repairing(), { type: 'need-info', reason: '请确认上线范围' });
    const waiting = bug.waitingForInfo;
    bug = change(bug, { type: 'fix-ready', ticket: 'DEMO-001', fixVersion: 'commit-1', evidenceRefs: ['test://passed'] });
    expect(bug).toMatchObject({ status: '待上线', fixVersion: 'commit-1', waitingForInfo: waiting });
    const deploy: BugAction = { type: 'deploy', fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: ['deployment://release-1'] };
    expect(() => change(bug, deploy)).toThrow('先补充');
    bug = change(bug, { type: 'supplement', raw: '已确认上线范围' });
    expect(bug.status).toBe('待上线');
    bug = change(bug, deploy);
    expect(bug.status).toBe('待验证');
  });

  it('requires deployment and matching verification evidence before closure', () => {
    let bug = repairing();
    expect(() => change(bug, { type: 'verify-pass', round: 1, fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: ['verify://ok'] })).toThrow(BugStoreError);
    bug = change(bug, { type: 'fix-ready', ticket: 'DEMO-001', fixVersion: 'commit-1', evidenceRefs: ['test://passed'] });
    expect(bug.status).toBe('待上线');
    expect(() => change(bug, { type: 'deploy', fixVersion: 'different', deployedVersion: 'release-1', evidenceRefs: ['deploy://done'] })).toThrow(BugConflictError);
    bug = change(bug, { type: 'deploy', fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: ['deploy://done'] });
    expect(() => change(bug, { type: 'verify-pass', round: 1, fixVersion: 'commit-1', deployedVersion: 'old-release', evidenceRefs: ['verify://ok'] })).toThrow(BugConflictError);
    expect(() => change(bug, { type: 'verify-pass', round: 1, fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: [] })).toThrow(BugStoreError);
    bug = change(bug, { type: 'verify-pass', round: 1, fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: ['verify://ok'] });
    expect(bug.status).toBe('已关闭');
    bug = change(bug, { type: 'reopen', reason: '线上再次出现' });
    expect(bug).toMatchObject({ status: '待复现', round: 2 });
    expect(bug.ticket).toBeUndefined();
    expect(bugByTicket('DEMO-001')?.id).toBe(bug.id);
    expect(bug.history.some(entry => entry.to === '已关闭')).toBe(true);
  });

  it('reopens the original Bug on failed verification and keeps every repair round', () => {
    let bug = awaitingVerification();
    const id = bug.id;
    bug = change(bug, { type: 'verify-fail', round: 1, fixVersion: 'commit-1', deployedVersion: 'release-1', evidenceRefs: ['verify://failed'], reason: '仍可复现' });
    expect(bug).toMatchObject({ id, status: '待复现', round: 2 });
    expect(bug.ticketAttempts).toHaveLength(1);
    expect(bug.history.at(-1)).toMatchObject({ reason: '仍可复现', actor: 'operator' });
    expect(bug.history.at(-1)?.action).toMatchObject({ round: 1, fixVersion: 'commit-1', deployedVersion: 'release-1' });
  });

  it('uses revision checks and request idempotency to reject stale cards and arbitrary patches', () => {
    const bug = createBug(input());
    const action: BugAction = { type: 'triage', severity: 'S2', requestId: 'action-1' };
    const next = change(bug, action);
    expect(change(bug, action).revision).toBe(next.revision);
    expect(change(bug, { requestId: 'action-1', severity: 'S2', type: 'triage' }).revision).toBe(next.revision);
    expect(() => change(bug, { type: 'update', priority: 'P0' })).toThrow(BugConflictError);
    expect(() => change(next, { ...action, severity: 'S1' })).toThrow(BugConflictError);
    expect(() => change(next, { type: 'update', status: '已关闭' } as unknown as BugAction)).toThrow(BugStoreError);
    expect(readBug(bug.id)?.status).toBe('待复现');
  });

  it('classifies duplicate, usage and requirement reports through explicit human actions', () => {
    const original = createBug(input());
    let duplicate = createBug({ ...input(), messageId: 'duplicate' });
    expect(() => change(duplicate, { type: 'duplicate', duplicateOf: duplicate.id, reason: '错误' })).toThrow(BugStoreError);
    duplicate = change(duplicate, { type: 'duplicate', duplicateOf: original.id, reason: '人工确认同一故障' });
    expect(duplicate.status).toBe('重复');
    expect(() => change(original, { type: 'duplicate', duplicateOf: duplicate.id, reason: '循环关联' })).toThrow('成环');
    let usage = createBug({ ...input(), messageId: 'usage' });
    usage = change(usage, { type: 'reclassify', classification: 'usage', reason: '配置错误' });
    expect(usage.status).toBe('使用问题');
    let requirement = createBug({ ...input(), messageId: 'requirement' });
    expect(() => change(requirement, { type: 'reclassify', classification: 'requirement', reason: '新增能力' })).toThrow('真实需求');
    const req = createReq({ project: 'demo', requester: 'reporter', chatId: 'chat', rootId: 'root', raw: '新增能力' });
    requirement = change(requirement, { type: 'reclassify', classification: 'requirement', relatedRequirement: req.id, reason: '新增能力' });
    expect(requirement).toMatchObject({ status: '已转需求', relatedRequirement: req.id });
    expect(listBugs()).toHaveLength(4);
    const active = repairing();
    expect(() => change(active, { type: 'reclassify', classification: 'usage', reason: '跳过' })).toThrow(BugStoreError);
    expect(() => change(active, { type: 'duplicate', duplicateOf: original.id, reason: '跳过' })).toThrow(BugStoreError);
  });

  it('rejects cross-process concurrent stale writes without losing history', async () => {
    const bug = createBug(input());
    const moduleUrl = new URL('../bugs.ts', import.meta.url).href;
    const run = (priority: string): Promise<string> => new Promise((resolve, reject) => {
      const script = `import {applyBugAction} from ${JSON.stringify(moduleUrl)}; try { applyBugAction(${JSON.stringify(bug.id)},1,{type:'update',priority:${JSON.stringify(priority)}},'child'); console.log('ok'); } catch(e) { if(e.code === 'BUG_CONFLICT') console.log('conflict'); else throw e; }`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env }, windowsHide: true });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    });
    expect((await Promise.all([run('P0'), run('P1')])).sort()).toEqual(['conflict', 'ok']);
    expect(readBug(bug.id)?.history).toHaveLength(2);
    expect(readBug(bug.id)?.revision).toBe(2);
  });
});
