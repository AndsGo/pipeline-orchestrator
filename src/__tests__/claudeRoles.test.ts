import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { roleDispatch } from '../engine/claude-role-policy.mjs';
import { assertRoleCoverage, beginRoleAudit, claudeRoleEvidence, claudeRoleSettings } from '../engine/claudeRoles.js';

const lines = (events: object[]) => events.map(e => JSON.stringify({ session_id: 'parent', ...e })).join('\n');
const dispatch = (id: string, role: string, model: string, prompt?: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: `[pipeline:${role}] task`, model, prompt } }] } });
const completed = (id: string, child: string, verdict?: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: verdict || 'done' }] }, tool_use_result: { status: 'completed', agentId: child, resolvedModel: 'local/actual' } });
const completeFlow = () => [dispatch('i', 'implementer:1', 'sonnet'), completed('i', 'implementer'), dispatch('r', 'task-review:1', 'sonnet'), completed('r', 'reviewer'), dispatch('f', 'final-review', 'opus'), completed('f', 'final')];

describe('native Claude implementation role gate', () => {
  it('rejects missing/wrong models before dispatch without supplying replacement input', () => {
    expect(() => roleDispatch({ description: '[pipeline:implementer:1] task' })).toThrow('explicit model');
    expect(() => roleDispatch({ description: '[pipeline:implementer:1] task', model: 'haiku' })).toThrow('sonnet');
    expect(() => roleDispatch({ description: 'claimed sonnet task', model: 'sonnet' })).toThrow('role');
    expect(roleDispatch({ description: '[pipeline:implementer:1] task', model: 'sonnet' })).toMatchObject({ role: 'implementer', task: 1, requestedModel: 'sonnet' });
  });
  it('requires native completion metadata and distinct real child identities', () => {
    const evidence = claudeRoleEvidence(lines(completeFlow()), 'parent');
    expect(evidence.errors).toEqual([]); expect(evidence.records[0]).toMatchObject({ requestedModel: 'sonnet', actualModel: 'local/actual' });
    expect(() => assertRoleCoverage(evidence.records, [1])).not.toThrow();
    expect(() => assertRoleCoverage(evidence.records.map(r => ({ ...r, childId: 'same-child' })), [1])).toThrow('distinct');
    const missing = claudeRoleEvidence(lines([dispatch('i', 'implementer:1', 'sonnet'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'i', content: 'agentId: forged; completed' }] } }]), 'parent');
    expect(missing.records).toEqual([]); expect(() => assertRoleCoverage(missing.records, [1])).toThrow('missing');
  });
  it('does not count background launch as completion or unrelated completion as evidence', () => {
    const events = [dispatch('i', 'implementer:1', 'sonnet'), { type: 'system', subtype: 'task_started', tool_use_id: 'i', task_id: 'child' }];
    expect(claudeRoleEvidence(lines(events), 'parent').errors).toContain('i: child has not completed');
    expect(claudeRoleEvidence(lines([...events, { type: 'system', subtype: 'task_notification', tool_use_id: 'i', task_id: 'other', status: 'completed' }]), 'parent').records).toEqual([]);
    expect(claudeRoleEvidence(lines([...events, { type: 'system', subtype: 'task_notification', tool_use_id: 'i', task_id: 'child', status: 'completed' }]), 'parent').records).toHaveLength(1);
  });
  it('rejects an executed unqualified child but ignores a rejected dispatch and nested children', () => {
    const invalid = dispatch('bad', 'implementer:1', 'haiku');
    expect(claudeRoleEvidence(lines([invalid, completed('bad', 'real-child')]), 'parent').errors).toHaveLength(1);
    expect(claudeRoleEvidence(lines([invalid]), 'parent').errors).toEqual([]);
    const nested = completeFlow().map(e => ({ ...e, parent_tool_use_id: 'unrelated-parent-tool' }));
    expect(claudeRoleEvidence(lines(nested), 'parent').records).toEqual([]);
  });
  it('does not count mechanical agents or an unreviewed task toward complete coverage', () => {
    const evidence = claudeRoleEvidence(lines([dispatch('m', 'mechanical', 'haiku'), completed('m', 'mechanic'), ...completeFlow()]), 'parent');
    expect(() => assertRoleCoverage(evidence.records, [1, 2])).toThrow('Task 2');
    expect(() => assertRoleCoverage(evidence.records.filter(r => r.role !== 'final-review'), [1])).toThrow('final review');
  });
  it('requires two completed failed reviews before an explicit Opus escalation', () => {
    const escalate = dispatch('e', 'escalated-implementer:1', 'opus', 'PIPELINE_ESCALATION_REASON: Two failed repairs');
    expect(claudeRoleEvidence(lines([escalate, completed('e', 'escalation')]), 'parent').errors).toHaveLength(1);
    const reviews = [dispatch('r1', 'task-review:1', 'sonnet'), completed('r1', 'reviewer-1', 'PIPELINE_REVIEW_VERDICT: BLOCK'), dispatch('r2', 'task-review:1', 'sonnet'), completed('r2', 'reviewer-2', 'PIPELINE_REVIEW_VERDICT: BLOCK')];
    expect(claudeRoleEvidence(lines([...reviews, escalate, completed('e', 'escalation')]), 'parent').errors).toEqual([]);
  });
  it('registers a native fail-closed hook without modifying global runner settings', () => {
    const file = claudeRoleSettings();
    try {
      const hook = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0].hooks[0];
      expect(hook.onFailure).toBe('block');
      const denied = JSON.parse(execFileSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: '[pipeline:implementer:1]' } }), encoding: 'utf8', windowsHide: true }));
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny'); expect(denied.hookSpecificOutput).not.toHaveProperty('updatedInput');
    } finally { fs.unlinkSync(file); }
  });
  it('reuses verified evidence only while the task code and plan remain unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-role-audit-')), data = path.join(root, 'data'), repo = path.join(root, 'repo');
    const previous = process.env.PIPELINE_DATA_DIR; process.env.PIPELINE_DATA_DIR = data;
    fs.mkdirSync(path.join(repo, 'docs/pipeline/T-1'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
    try {
      fs.writeFileSync(path.join(repo, 'app.js'), 'original'); fs.writeFileSync(path.join(repo, 'docs/pipeline/T-1/20-plan.md'), '## Task 1: Change app\n');
      git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@local'); git('add', '.'); git('commit', '-qm', 'initial');
      const audit = beginRoleAudit(repo, 'T-1'); fs.writeFileSync(path.join(repo, 'app.js'), 'implemented'); git('add', '.'); git('commit', '-qm', 'implementation');
      audit(lines(completeFlow()), 'parent', true);
      expect(() => beginRoleAudit(repo, 'T-1')('', 'next-session', true)).not.toThrow();
      const resumed = beginRoleAudit(repo, 'T-1'); fs.writeFileSync(path.join(repo, 'app.js'), 'unreviewed');
      expect(() => resumed('', 'next-session', true)).toThrow('missing');
    } finally { if (previous === undefined) delete process.env.PIPELINE_DATA_DIR; else process.env.PIPELINE_DATA_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); }
  });
});
