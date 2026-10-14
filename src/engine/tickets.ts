import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';
import type { TicketState } from '../types.js';
import { ENTRIES, assertExecutable, freezeExecution, initialConfiguration, type ExecutionPlan, ExecutionConfigError, type PendingSwitch, validatePlan, knownCli } from './configuration.js';
import { readEvents } from '../events.js';
import { readProfile } from '../profile.js';
import { appendEvent } from '../events.js';
import { readSnapshot } from '../ticket.js';
import type { TicketRun } from '../run/context.js';
import { withFileLock } from './fileLock.js';

/** Migration preserves evidence; an unknown historical CLI is never guessed. */
export function ensureExecutionPlan(state: TicketState): TicketState {
  if (state.executionPlan) { validatePlan(state.executionPlan); return state; }
  const root = state.mainRepo || state.repo;
  const legacy = readProfile(root)?.engine;
  const profiles = initialConfiguration().profiles;
  const plan = Object.fromEntries(ENTRIES.map(entry => {
    const cli = knownCli(legacy?.byStage[entry] || legacy?.default || 'claude');
    return [entry, { ...freezeExecution(root, entry, profiles.find(p => p.cli === cli)!, state.repo), constraintMode: 'strict' }];
  })) as ExecutionPlan;
  const events = readEvents(state.ticket);
  for (const entry of ENTRIES) {
    const runs = state.runs.filter(r => r.stage === entry);
    const last = runs.at(-1);
    const evidence = events.filter(e => e.type === 'stage.start' && e.stage === entry && typeof e.payload?.model === 'string').at(-1)?.payload?.model as string | undefined;
    if (last?.execution) { plan[entry] = structuredClone(last.execution); continue; }
    if (!last && !evidence) continue;
    const cli = evidence?.startsWith('codex:') ? 'codex' : evidence && /^(opus|sonnet|haiku)$/i.test(evidence) ? 'claude' : undefined;
    if (!cli) throw new ExecutionConfigError(`旧工单 ${state.ticket} 的 ${entry} 缺少实际 CLI 记录，无法安全迁移；请显式指定执行配置。`);
    const profile = initialConfiguration().profiles.find(p => p.cli === cli)!;
    const snapshot = freezeExecution(state.mainRepo || state.repo, entry, profile, state.repo);
    snapshot.constraintMode = 'strict';
    snapshot.model = evidence!.replace(/^codex:/, '') === '默认' ? '@cli-default' : evidence!.replace(/^codex:/, '');
    plan[entry] = snapshot;
  }
  if (state.implementModel && plan.implement.profile.cli === 'claude') plan.implement.model = state.implementModel;
  validatePlan(plan);
  return { ...state, executionPlan: plan };
}
const switchFile = (ticket: string): string => {
  if (!/^[A-Za-z]{1,6}-\d{1,6}$/.test(ticket)) throw new ExecutionConfigError('工单号不合法');
  return path.join(dataDir(), `${ticket}.execution-switch.json`);
};
function withSwitchLock<T>(ticket: string, fn: () => T): T {
  const lock = `${switchFile(ticket)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  return withFileLock(lock, fn);
}
/** Separate mailbox: the running daemon cannot overwrite a request by saving its state. */
export function queueExecutionSwitch(state: TicketState, plan: ExecutionPlan, by: string, reason: string): PendingSwitch {
  if (!reason.trim()) throw new ExecutionConfigError('切换必须填写原因');
  validatePlan(plan);
  for (const snapshot of Object.values(plan)) assertExecutable(snapshot);
  const events = readEvents(state.ticket).filter(e => e.type === 'stage.end' || (e.type === 'error' && !e.summary.includes('自动重试')) || (e.type === 'stage.start' && !e.summary.startsWith('进度：')));
  const latest = events.at(-1);
  const afterStage = !state.haltedReason && !state.pendingGate && latest?.type === 'stage.start' ? latest.stage || state.cursor : '';
  const request: PendingSwitch = { plan: structuredClone(plan), by, reason: reason.trim(), requestedAt: new Date().toISOString(), afterStage, requestId: randomUUID() };
  const file = switchFile(state.ticket);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  withSwitchLock(state.ticket, () => {
    try {
      fs.writeFileSync(temporary, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  });
  return request;
}
export function pendingSwitch(ticket: string): PendingSwitch | undefined {
  const file = switchFile(ticket);
  if (!fs.existsSync(file)) return undefined;
  const request = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingSwitch;
  validatePlan(request.plan);
  if (request.requestId !== undefined && !/^[0-9a-f-]{36}$/.test(request.requestId)) throw new ExecutionConfigError('切换请求 ID 不合法');
  if (typeof request.by !== 'string' || typeof request.reason !== 'string' || typeof request.requestedAt !== 'string' || typeof request.afterStage !== 'string') throw new ExecutionConfigError('切换请求格式不合法');
  return request;
}
export function switchReady(state: TicketState, pending: PendingSwitch): boolean {
  // Same stage includes fix/retry and batch continuation; they retain the old snapshot.
  return !pending.afterStage || !!state.haltedReason || state.cursor !== pending.afterStage;
}
export function clearExecutionSwitch(ticket: string, requestedAt: string): void {
  withSwitchLock(ticket, () => {
    const latest = pendingSwitch(ticket);
    if (latest?.requestId === requestedAt || (!latest?.requestId && latest?.requestedAt === requestedAt)) fs.unlinkSync(switchFile(ticket));
  });
}
export async function applyExecutionSwitch(run: TicketRun): Promise<void> {
  // Merge independently persisted human instructions before saving any config change.
  const disk = readSnapshot(run.ticket);
  if (disk?.pendingRewind && !run.state.pendingRewind) run.state = { ...run.state, pendingRewind: disk.pendingRewind };
  const request = pendingSwitch(run.ticket);
  if (request && run.state.appliedExecutionSwitch === (request.requestId || request.requestedAt)) {
    auditSwitch(run, request, run.state.executionSwitchPrevious);
    clearExecutionSwitch(run.ticket, request.requestId || request.requestedAt); return;
  }
  if (!request || !switchReady(run.state, request)) return;
  const previous = run.state.executionPlan;
  run.state = { ...run.state, executionPlan: request.plan, appliedExecutionSwitch: request.requestId || request.requestedAt, executionSwitchPrevious: previous };
  run.save();
  auditSwitch(run, request, previous);
  clearExecutionSwitch(run.ticket, request.requestId || request.requestedAt);
  await run.port.notify(run.ticket, `已在阶段边界切换执行配置：${request.reason}`);
}
function auditSwitch(run: TicketRun, request: PendingSwitch, previous?: ExecutionPlan): void {
  const requestId = request.requestId || request.requestedAt;
  if (readEvents(run.ticket).some(e => e.payload?.requestId === requestId)) return;
  appendEvent({ ticket: run.ticket, type: 'human.message', summary: `执行配置切换：${request.reason}`, payload: { requestId, by: request.by, requestedAt: request.requestedAt, previous, plan: request.plan } });
}
