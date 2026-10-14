import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { roleDispatch, type RoleDispatch } from './claude-role-policy.mjs';
import { dataDir } from '../paths.js';
import { RUNNER_SETTINGS } from '../config.js';

export interface RoleEvidence extends RoleDispatch { toolUseId: string; childId: string; sessionId: string; actualModel?: string; reviewVerdict?: 'PASS' | 'BLOCK'; }
export function claudeRoleEvidence(stdout: string, sessionId: string, previous: RoleEvidence[] = []) {
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const dispatches = new Map<string, { input: unknown; index: number }>();
  const starts = new Map<string, string>(), models = new Map<string, string>(), completions = new Map<string, { child: string; model?: string; verdict?: 'PASS' | 'BLOCK'; index: number }>();
  for (const [index, e] of events.entries()) {
    if (e.session_id !== sessionId || e.parent_tool_use_id) continue;
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) for (const call of e.message.content) {
      if (call.type === 'tool_use' && ['Agent', 'Task'].includes(call.name) && typeof call.id === 'string') dispatches.set(call.id, { input: call.input, index });
    }
    if (e.type === 'system' && e.subtype === 'task_started' && typeof e.tool_use_id === 'string' && typeof e.task_id === 'string') starts.set(e.tool_use_id, e.task_id);
    if (e.type === 'system' && e.subtype === 'task_notification' && e.status === 'completed' && starts.get(e.tool_use_id) === e.task_id) completions.set(e.tool_use_id, { child: e.task_id, model: models.get(e.tool_use_id), index });
    if (e.type === 'user' && Array.isArray(e.message?.content)) for (const result of e.message.content) {
      const meta = e.tool_use_result;
      if (result.type !== 'tool_result' || result.is_error || !meta || typeof meta !== 'object') continue;
      if (meta.status === 'async_launched' && typeof meta.agentId === 'string') { starts.set(result.tool_use_id, meta.agentId); if (typeof meta.resolvedModel === 'string') models.set(result.tool_use_id, meta.resolvedModel); }
      if (meta.status === 'completed' && typeof meta.agentId === 'string' && meta.agentId) {
        const text = typeof result.content === 'string' ? result.content : Array.isArray(result.content) ? result.content.filter((p: { type?: string }) => p.type === 'text').map((p: { text?: string }) => p.text || '').join('\n') : '';
        const verdict = /^PIPELINE_REVIEW_VERDICT: (PASS|BLOCK)$/m.exec(text)?.[1] as 'PASS' | 'BLOCK' | undefined;
        completions.set(result.tool_use_id, { child: meta.agentId, model: meta.resolvedModel, verdict, index });
      }
    }
  }
  const errors: string[] = [], records: RoleEvidence[] = [];
  for (const [toolUseId, dispatch] of dispatches) {
    const completed = completions.get(toolUseId);
    if (!completed && !starts.has(toolUseId)) continue; // A denied dispatch is not an executed child.
    let role: RoleDispatch;
    try { role = roleDispatch(dispatch.input); } catch (e) { errors.push((e as Error).message); continue; }
    if (!completed || completed.index <= dispatch.index) { errors.push(`${toolUseId}: child has not completed`); continue; }
    if (!completed.child || completed.child === sessionId || (starts.has(toolUseId) && starts.get(toolUseId) !== completed.child)) { errors.push(`${toolUseId}: conflicting native child identity`); continue; }
    if (role.role === 'escalated-implementer') {
      const failed = [...previous, ...records.filter(r => (completions.get(r.toolUseId)?.index ?? Infinity) < dispatch.index)].filter(r => r.role === 'task-review' && r.task === role.task && r.reviewVerdict === 'BLOCK');
      if (failed.length < 2) { errors.push(`Task ${role.task}: escalation lacks two completed failed independent reviews`); continue; }
    }
    records.push({ ...role, toolUseId, childId: completed.child, sessionId, actualModel: completed.model, reviewVerdict: completed.verdict });
  }
  return { records, errors };
}

export function assertRoleCoverage(records: RoleEvidence[], expectedTasks: number[]) {
  const roleChildren = new Map<string, string>();
  for (const r of records) {
    const identity = `${r.role === 'escalated-implementer' ? 'implementer' : r.role}:${r.task ?? ''}`;
    const previous = roleChildren.get(r.childId);
    if (previous && previous !== identity) throw new Error('Implementation, task review and final review must use distinct native children');
    roleChildren.set(r.childId, identity);
  }
  if (!expectedTasks.length) throw new Error('No planned implementation tasks found; role coverage cannot be established');
  for (const task of expectedTasks) {
    if (!records.some(r => ['implementer', 'escalated-implementer'].includes(r.role) && r.task === task) || !records.some(r => r.role === 'task-review' && r.task === task)) throw new Error(`Task ${task}: missing completed independent implementation or task review evidence`);
  }
  if (!records.some(r => r.role === 'final-review')) throw new Error('Missing completed independent whole-branch final review evidence');
}

/** Entry-scoped native settings; never changes user/project settings or credentials. */
export function claudeRoleSettings() {
  const config = JSON.parse(fs.readFileSync(RUNNER_SETTINGS, 'utf8'));
  const file = path.join(os.tmpdir(), `pipeline-role-settings-${randomUUID()}.json`);
  const script = fileURLToPath(new URL('./claude-role-policy.mjs', import.meta.url)).replace(/\\/g, '/');
  config.hooks ??= {}; config.hooks.PreToolUse ??= [];
  config.hooks.PreToolUse.push({ matcher: '^(Agent|Task)$', hooks: [{ type: 'command', command: process.execPath.replace(/\\/g, '/'), args: [script, '--native-hook'], timeout: 10, onFailure: 'block' }] });
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
export function beginRoleAudit(repo: string, ticket: string) {
  const base = git(repo, 'rev-parse', 'HEAD');
  const id = createHash('sha256').update(fs.realpathSync.native(repo)).update('\0').update(ticket).digest('hex');
  const file = path.join(dataDir(), 'agent-role-evidence', `${id}.json`);
  const digest = (relative: string) => { const full = path.resolve(repo, relative); if (path.relative(repo, full).startsWith('..')) throw new Error('Role evidence path escapes repository'); return fs.existsSync(full) ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : 'missing'; };
  let prior: { records: RoleEvidence[]; files: Record<string, string>; commit: string } | undefined;
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version === 1 && saved.repo === fs.realpathSync.native(repo) && saved.ticket === ticket && Array.isArray(saved.records) && typeof saved.commit === 'string' && saved.files && typeof saved.files === 'object') {
      try { git(repo, 'merge-base', '--is-ancestor', saved.commit, base); if (Object.entries(saved.files).every(([p, hash]) => digest(p) === hash)) prior = saved; } catch { /* unrelated or changed code cannot reuse old proof */ }
    }
  }
  const plan = path.join(repo, 'docs/pipeline', ticket, '20-plan.md');
  const expectedTasks = fs.existsSync(plan) ? [...new Set([...fs.readFileSync(plan, 'utf8').matchAll(/^#{1,6}\s+(?:Task|任务)\s*(\d+)\b/gmi)].map(m => Number(m[1])))] : [];
  return (stdout: string, sessionId: string, success: boolean) => {
    const reusable = prior && Object.entries(prior.files).every(([p, hash]) => digest(p) === hash) ? prior : undefined;
    const current = claudeRoleEvidence(stdout, sessionId, reusable?.records);
    const records = [...(reusable?.records || []), ...current.records];
    const commit = git(repo, 'rev-parse', 'HEAD');
    const changed = git(repo, 'diff', '--name-only', base, commit).split('\n').filter(Boolean).filter(p => !p.startsWith(`docs/pipeline/${ticket}/`));
    const tracked = git(repo, 'ls-files').split('\n').filter(Boolean).filter(p => !p.startsWith(`docs/pipeline/${ticket}/`));
    const files = [...new Set([...Object.keys(reusable?.files || {}), ...(changed.length ? changed : tracked), 'AGENTS.md', 'docs/pipeline/PROJECT-KNOWLEDGE.md', `docs/pipeline/${ticket}/10-prd.md`, `docs/pipeline/${ticket}/20-plan.md`])];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, repo: fs.realpathSync.native(repo), ticket, commit, files: Object.fromEntries(files.map(p => [p, digest(p)])), records }, null, 2), { mode: 0o600 });
    if (!success) return; // Preserve a genuine BLOCKED/NEEDS_CONTEXT result.
    if (current.errors.length) throw new Error(current.errors.join('; '));
    assertRoleCoverage(records, expectedTasks);
  };
}
