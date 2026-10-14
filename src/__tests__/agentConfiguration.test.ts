import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertExecutable, configurationFile, ENTRIES, freezeExecution, freezePlan, initialConfiguration, profileFingerprint, readConfiguration, selectProfile, validateConfiguration, writeConfiguration, type AgentProfile } from '../engine/configuration.js';
import { clearExecutionSwitch, ensureExecutionPlan, pendingSwitch, queueExecutionSwitch, switchReady } from '../engine/tickets.js';
import { validationPlan } from '../engine/validation.js';
import { loadTicket, saveTicket, readSnapshot } from '../ticket.js';
import { engineFor, engineNamed } from '../engine/index.js';
import { parseClaudeOutput, runClaudeText, claudeTrace } from '../runner.js';
import * as subprocess from '../engine/process.js';
import { summarizeOpenCode, openCodeConfiguration, completeOpenCodeFromExport } from '../engine/opencode.js';
import { validateProfile, recordValidation, openCodeParentReadsSecret } from '../engine/validation.js';
import { readSuggestions, applyClaudeMdSuggestions } from '../suggestions.js';
import { sharedPrompt } from '../engine/prompt.js';
import { appendEvent } from '../events.js';
import * as identity from '../engine/identity.js';
import { failureUsage } from '../engine/errors.js';

let root: string;
let repo: string;
const savedEnvironment = { ...process.env };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'docs/pipeline'), { recursive: true });
  process.env.PIPELINE_DATA_DIR = path.join(root, 'data');
  delete process.env.PIPELINE_AGENT_CONFIG_FILE;
  delete process.env.PIPELINE_IMPLEMENT_MODEL;
  vi.spyOn(identity, 'assertRuntimeIdentity').mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); process.env = { ...savedEnvironment }; fs.rmSync(root, { recursive: true, force: true }); });
describe('OpenCode native structured replies', () => {
  it('isolates the independent-child probe parent while retaining the child native read permission', () => {
    const config = openCodeConfiguration('Read,Agent,Task', 8, false, 'parent', 'worker', true) as { agents: Record<string, { permissions: { action: string; effect: string }[] }> };
    expect(config.agents.parent.permissions.filter(p => p.action === 'read').at(-1)?.effect).toBe('deny');
    expect(config.agents.worker.permissions.filter(p => p.action === 'read').at(-1)?.effect).toBe('allow');
    expect(openCodeParentReadsSecret([{ type: 'tool_use', part: { tool: 'read', state: { status: 'error', error: 'Permission denied', input: { path: 'child-marker.txt' } } } }], 'marker')).toBe(false);
    expect(openCodeParentReadsSecret([{ type: 'tool_use', part: { tool: 'read', state: { status: 'error', error: 'Permission denied', metadata: { content: ['marker'] } } } }], 'marker')).toBe(true);
  });
  it('retains session and turns when a failed call has no dollar pricing', () => {
    expect(failureUsage({ is_error: true, session_id: 'unpriced-session', num_turns: 2, total_cost_usd: 0, costStatus: 'unknown', permission_denials: [] }))
      .toEqual({ costStatus: 'unknown', turns: 2, sessionId: 'unpriced-session' });
  });
  function transcript(text: string) {
    return [
      { type: 'text', sessionID: 'structured-session', part: { messageID: 'final', text } },
      { type: 'step_finish', sessionID: 'structured-session', part: { messageID: 'final', reason: 'stop', cost: 0.25 } },
    ].map(event => JSON.stringify(event)).join('\n');
  }
  const opts = { prompt: 'return JSON', model: 'provider/model', tools: 'Read', maxTurns: 5, budgetUsd: 0, schema: { type: 'object' } };
  it('passes the free model explicitly and does not retry with a paid model after provider rejection', async () => {
    const run = vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 1, stderr: '', stdout: JSON.stringify({ type: 'error', sessionID: 'free-denied', error: { message: "OpenCode's free tier can only be used from within OpenCode." } }) });
    await expect(engineNamed('opencode').runJson({ ...opts, model: 'opencode/space-bunny-free', cwd: repo, constraintMode: 'native' })).rejects.toThrow('free tier');
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0][1];
    expect(args[args.indexOf('--model') + 1]).toBe('opencode/space-bunny-free');
    const config = JSON.parse(run.mock.calls[0][2].env!.OPENCODE_CONFIG_CONTENT!);
    const executor = Object.values(config.agents).find((a: any) => a.mode === 'primary') as any;
    expect(executor.permissions.some((p: any) => p.action === 'shell' && p.effect === 'allow')).toBe(false);
  });
  it('accepts a single complete JSON fence only in native mode', async () => {
    const run = vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stderr: '', stdout: transcript('```json\n{"ok":true}\n```') });
    const outcome = await engineNamed('opencode').runJson({ ...opts, cwd: repo, constraintMode: 'native' });
    expect(outcome.envelope.structured_output).toEqual({ ok: true });
    const config = JSON.parse(run.mock.calls[0][2].env!.OPENCODE_CONFIG_CONTENT!);
    const executor = Object.keys(config.agents).find(name => name.endsWith('-executor'))!;
    expect(config.agents[executor].system).toContain(JSON.stringify(opts.schema));
    await expect(engineNamed('opencode').runJson({ ...opts, cwd: repo, constraintMode: 'strict' })).rejects.toThrow('不是 JSON');
  });
  it('rejects prose around JSON and preserves the real session and usage on failure', async () => {
    vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stderr: '', stdout: transcript('Done.\n```json\n{"ok":true}\n```') });
    await expect(engineNamed('opencode').runJson({ ...opts, cwd: repo, constraintMode: 'native' })).rejects.toMatchObject({
      envelope: { session_id: 'structured-session', num_turns: 2, total_cost_usd: 0.5, costStatus: 'reported' },
    });
  });
  it('uses one tool-free native correction in the same session, retains both outputs and accounts both calls', async () => {
    const run = vi.spyOn(subprocess, 'runProcess')
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('Done.\n```json\n{"ok":true}\n```') })
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('{"ok":true}') });
    const outcome = await engineNamed('opencode').runJson({ ...opts, cwd: repo, constraintMode: 'native', timeoutMs: 90000 });
    expect(outcome.envelope).toMatchObject({ session_id: 'structured-session', num_turns: 2, total_cost_usd: 0.5, structured_output: { ok: true } });
    expect(outcome.rawStdout).toContain('Done.'); expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toContain('structured-session');
    expect(run.mock.calls[1][2].timeoutMs).toBeLessThanOrEqual(90000);
    const config = JSON.parse(run.mock.calls[1][2].env!.OPENCODE_CONFIG_CONTENT!);
    const executor = Object.values(config.agents).find((a: any) => a.mode === 'primary') as any;
    expect(executor.steps).toBe(1); expect(executor.permissions.filter((p: any) => p.effect === 'allow').map((p: any) => p.action)).toEqual(['external_directory']);
  });
  it('rejects tool execution during correction and never corrects incomplete native output', async () => {
    const run = vi.spyOn(subprocess, 'runProcess')
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('Done. {"ok":true}') })
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: JSON.stringify({ type: 'tool_use', sessionID: 'structured-session', part: { tool: 'subagent' } }) + '\n' + transcript('{"ok":true}') });
    await expect(engineNamed('opencode').runJson({ ...opts, cwd: repo, constraintMode: 'native' })).rejects.toThrow('调用了任务工具');
    run.mockReset().mockResolvedValue({ code: 0, stderr: '', stdout: JSON.stringify({ type: 'text', sessionID: 'structured-session', part: { messageID: 'final', text: 'Partial' } }) });
    await expect(engineNamed('opencode').runJson({ ...opts, cwd: repo, constraintMode: 'native' })).rejects.toThrow();
    expect(run.mock.calls.filter(c => c[1][0] === 'run')).toHaveLength(1);
  });
  it('corrects only an overlong card summary and rejects changes to the actual outcome', async () => {
    const schema = { type: 'object', required: ['summary_for_card', 'status'], additionalProperties: false, properties: { summary_for_card: { type: 'string', maxLength: 5 }, status: { type: 'string', enum: ['DONE', 'BLOCKED'] } } };
    const run = vi.spyOn(subprocess, 'runProcess')
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('{"summary_for_card":"too long","status":"DONE"}') })
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('{"status":"DONE","summary_for_card":"short"}') });
    expect((await engineNamed('opencode').runJson({ ...opts, schema, cwd: repo, constraintMode: 'native' })).envelope.structured_output).toEqual({ status: 'DONE', summary_for_card: 'short' });
    run.mockReset()
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('{"summary_for_card":"too long","status":"BLOCKED"}') })
      .mockResolvedValueOnce({ code: 0, stderr: '', stdout: transcript('{"status":"DONE","summary_for_card":"short"}') });
    await expect(engineNamed('opencode').runJson({ ...opts, schema, cwd: repo, constraintMode: 'native' })).rejects.toThrow('改变了其他结果字段');
  });
});
function active(id: string, model = 'sonnet'): AgentProfile {
  const p: AgentProfile = { id, name: id, cli: 'claude', model, parameters: {}, state: 'active' };
  const entries = ['run', 'review', 'implement', 'clarify', 'plan', 'triage', 'fast', 'acceptance', 'compound', 'classify', 'draft', 'prototype', 'mr-review'] as const;
  p.validation = { fingerprint: profileFingerprint(p), at: '2026-10-11', entries: [...entries], cliVersion: 'test', account: identity.executionAccount(), checks: ['Playwright MCP test'], resolved: Object.fromEntries(entries.map(entry => [entry, model])) };
  return p;
}
describe('named execution configuration', () => {
  it('verifies every distinct native Codex capability without repeating unenforced turn and budget limits', () => {
    const plan = validationPlan({ id: 'codex-test', name: 'Codex', cli: 'codex', model: 'gpt-test', constraintMode: 'native', state: 'draft', parameters: {} }, [...ENTRIES], { browser: false });
    expect(plan.entries).toEqual([...ENTRIES]); expect(plan.errors).toEqual([]);
    expect(plan.contexts).toHaveLength(3); expect(plan.calls).toBe(14); expect(plan.initializationCalls).toBe(1);
    expect(plan.contexts.every(c => c.model === 'gpt-test')).toBe(true);
    expect(plan.contexts.filter(c => c.entry === 'implement')).toHaveLength(1);
  });
  it('includes the possible native OpenCode browser JSON correction in the displayed call limit', () => {
    const profile: AgentProfile = { id: 'opencode-test', name: 'OpenCode', cli: 'opencode', model: 'provider/model', constraintMode: 'native', state: 'draft', parameters: {} };
    expect(validationPlan(profile, ['review'], { browser: false }).calls).toBe(6);
    expect(validationPlan(profile, ['review'], { browser: true }).calls).toBe(8);
    expect(validationPlan({ ...profile, constraintMode: 'strict' }, ['review'], { browser: true }).calls).toBe(0);
  });
  it('CAS writes are atomic and invalid names never silently select Claude', () => {
    const c = initialConfiguration();
    const written = writeConfiguration(c, 0);
    expect(written.revision).toBe(1);
    expect(() => writeConfiguration(c, 0)).toThrow('已被修改');
    expect(fs.existsSync(`${configurationFile()}.lock`)).toBe(false);
    expect(readConfiguration().revision).toBe(1);
    expect(() => engineNamed('missing')).toThrow('未知');
  });
  it('project-entry > file-entry > project-default > global-entry > global-default', () => {
    const c = initialConfiguration();
    c.profiles.push(active('global'), active('project'), active('file'), active('entry'));
    c.global = { default: 'global', entries: { review: 'global' } };
    c.projects[repo] = { default: 'project' };
    fs.writeFileSync(path.join(repo, 'docs/pipeline/PIPELINE.md'), '---\nexecution.review: file\n---\n');
    expect(selectProfile(repo, 'review', c).id).toBe('file');
    expect(selectProfile(repo, 'run', c).id).toBe('project');
    c.projects[repo].entries = { review: 'entry' };
    expect(selectProfile(repo, 'review', c).id).toBe('entry');
    expect(selectProfile(undefined, 'run', c).id).toBe('global');
  });
  it('unvalidated or stale profiles are blocked, including direct-file edits', () => {
    const c = initialConfiguration();
    c.profiles.push({ ...active('draft'), state: 'draft', validation: undefined });
    c.global.default = 'draft';
    expect(() => selectProfile(repo, 'run', c)).toThrow('尚未通过');
    c.profiles[3] = active('draft');
    c.profiles[3].model = 'opus';
    expect(() => validateConfiguration(c)).toThrow('能力验证');
  });
  it('new ticket snapshots survive settings edits, process restart and environment drift', () => {
    const c = initialConfiguration(); c.profiles.push(active('chosen')); c.global.default = 'chosen'; writeConfiguration(c, 0);
    const state = loadTicket(repo, 'DM-1', 'clarify'); saveTicket(state);
    const changed = readConfiguration(); changed.profiles[3] = active('chosen', 'opus'); writeConfiguration(changed, 1);
    process.env.PIPELINE_RUN_MODEL = 'haiku';
    expect(readSnapshot('DM-1')?.executionPlan?.run.model).toBe('sonnet');
    expect(loadTicket(repo, 'DM-1', 'clarify').executionPlan?.implement.model).toBe('sonnet');
    expect(freezeExecution(repo, 'run').model).toBe('opus');
  });
  it('worktree execution keeps project bindings attached to the logical main repository', () => {
    const c = initialConfiguration(); c.profiles.push(active('project', 'haiku')); c.projects[repo] = { default: 'project' }; writeConfiguration(c, 0);
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
    const state = loadTicket(worktree, 'DM-8', 'clarify', { alias: 'demo', prefix: 'DM', repo });
    expect(state.mainRepo).toBe(repo);
    expect(state.executionPlan?.clarify.profile.id).toBe('project');
  });
  it('pending approval and pre-start switches apply to the next call, but current retries do not', () => {
    const state = loadTicket(repo, 'DM-9', 'implement');
    state.pendingGate = { stage: 'plan', gate: 'plan-approval', summary: '', concerns: [] };
    appendEvent({ ticket: 'DM-9', type: 'stage.start', stage: 'plan', summary: '阶段 plan' });
    const request = queueExecutionSwitch(state, freezePlan(repo), 'tester', 'approved configuration change');
    expect(switchReady(state, request)).toBe(true);
    expect(() => queueExecutionSwitch(state, {} as never, 'tester', 'invalid')).toThrow('不完整');
  });
  it('draft snapshots and incomplete stored plans cannot bypass validation', () => {
    const p = { ...active('unsafe'), state: 'draft' as const, validation: undefined };
    expect(() => assertExecutable(freezeExecution(repo, 'run', p))).toThrow('草稿');
    const state = loadTicket(repo, 'DM-10', 'plan'); delete (state.executionPlan as Partial<typeof state.executionPlan>)?.review;
    expect(() => ensureExecutionPlan(state)).toThrow('不完整');
  });
  it('frozen /run uses original CLI and model despite current configuration changes', async () => {
    const frozen = freezeExecution(repo, 'run', active('old', 'haiku'));
    const c = initialConfiguration(); c.global.default = 'legacy-codex'; writeConfiguration(c, 0);
    const spy = vi.spyOn(engineNamed('claude'), 'runText').mockResolvedValue({ text: 'ok', isError: false, turns: 1, costUsd: 0.01, sessionId: 'original' });
    const result = await engineFor(repo, 'run', frozen).runText({ cwd: repo, prompt: 'continue', tools: 'Write', model: 'opus', maxTurns: 99, budgetUsd: 99, resumeSessionId: 'original', settingSources: '' });
    expect(spy.mock.calls[0][0].model).toBe('haiku');
    expect(spy.mock.calls[0][0].tools).not.toContain('Write');
    expect(spy.mock.calls[0][0].settingSources).toBeUndefined();
    expect(result.execution?.profile.id).toBe('old');
    spy.mockResolvedValue({ text: 'oops', isError: false, turns: 1, costUsd: 0, sessionId: 'new' });
    await expect(engineFor(repo, 'run', frozen).runText({ cwd: repo, prompt: 'continue', tools: '', model: '', maxTurns: 1, budgetUsd: 1, resumeSessionId: 'original' })).rejects.toThrow('未恢复原会话');
  });
  it('unsupported hard constraints fail before any model invocation, even legacy settings', async () => {
    const c = initialConfiguration(); c.global.default = 'legacy-opencode'; writeConfiguration(c, 0);
    const spy = vi.spyOn(engineNamed('opencode'), 'runText');
    const historical = freezeExecution(repo, 'run'); historical.model = 'provider/model'; delete historical.constraintMode;
    await expect(engineFor(repo, 'run', historical).runText({ cwd: repo, prompt: 'x', tools: '', model: '', maxTurns: 1, budgetUsd: 1, constraintMode: 'native' })).rejects.toThrow('金额上限');
    expect(spy).not.toHaveBeenCalled();
    expect(() => assertExecutable({ ...freezeExecution(repo, 'run', c.profiles[1]), constraintMode: 'strict' })).toThrow('白名单');
  });
  it('native mode freezes policy and permits the native CLI without claiming enforced budget or tool parity', async () => {
    const snapshot = freezeExecution(repo, 'run', initialConfiguration().profiles[1]); snapshot.model = 'gpt-test';
    const spy = vi.spyOn(engineNamed('codex'), 'runText').mockResolvedValue({ text: 'native', isError: false, turns: 1, costUsd: 0, sessionId: 'codex-session', costStatus: 'unknown' });
    const result = await engineFor(repo, 'run', snapshot).runText({ cwd: repo, prompt: 'x', tools: '', model: '', maxTurns: 0, budgetUsd: 0, constraintMode: 'strict' });
    expect(spy.mock.calls[0][0].constraintMode).toBe('native');
    expect(spy.mock.calls[0][0].budgetUsd).toBe(snapshot.budgetUsd);
    expect(result.costStatus).toBe('unknown');
  });
  it('partial activation can be selected by entry but cannot become an unverified all-entry default', () => {
    const profile = active('partial'); profile.validation!.entries = ['run'];
    const config = initialConfiguration(); config.profiles.push(profile); config.global.entries = { run: profile.id };
    expect(validateConfiguration(config)).toBe(config);
    config.global.default = profile.id;
    expect(() => validateConfiguration(config)).toThrow('默认配置必须验证全部入口');
    delete config.global.default; config.global.entries = { implement: profile.id };
    expect(() => validateConfiguration(config)).toThrow('未验证入口 implement');
  });
  it('native Codex retains credentials but removes controller thread IDs and applies its native effort', async () => {
    process.env.CODEX_HOME = path.join(root, 'native-home');
    process.env.CODEX_THREAD_ID = 'controller-thread'; process.env.CODEX_SESSION_ID = 'controller-session';
    const stream = [JSON.stringify({ type: 'thread.started', thread_id: 'fresh-thread' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'native reply' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })].join('\n');
    const processSpy = vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stdout: stream, stderr: '' });
    const response = await engineNamed('codex').runText({ cwd: repo, prompt: 'test', tools: 'Read', model: 'gpt-test', maxTurns: 5, budgetUsd: 3, constraintMode: 'native', effort: 'low' });
    expect(response.rawStdout).toBe(stream);
    expect(response.costStatus).toBe('unknown');
    expect(processSpy.mock.calls[0][2].env?.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(processSpy.mock.calls[0][2].env?.CODEX_THREAD_ID).toBeUndefined();
    expect(processSpy.mock.calls[0][2].env?.CODEX_SESSION_ID).toBeUndefined();
    expect(processSpy.mock.calls[0][1]).toContain('model_reasoning_effort="low"');
  });
  it('credential evidence hashes the actual CODEX_HOME configuration', () => {
    process.env.CODEX_HOME = path.join(root, 'native-home'); fs.mkdirSync(process.env.CODEX_HOME);
    const config = path.join(process.env.CODEX_HOME, 'config.toml');
    fs.writeFileSync(config, 'model="first"'); const before = identity.credentialContext();
    fs.writeFileSync(config, 'model="second"'); expect(identity.credentialContext()).not.toBe(before);
  });
  it('old state migration preserves proven CLI and blocks unknown history', () => {
    const state = loadTicket(repo, 'DM-2', 'review'); delete state.executionPlan;
    state.runs = [{ stage: 'review', extraArgs: '', startedAt: '', costUsd: 0, turns: 1, status: 'DONE', sessionId: 'x', model: 'opus' }];
    appendEvent({ ticket: 'DM-2', type: 'stage.start', stage: 'review', summary: 'review', payload: { model: 'codex:gpt-test' } });
    const migrated = ensureExecutionPlan(state);
    expect(migrated.executionPlan?.review.profile.cli).toBe('codex');
    expect(migrated.executionPlan?.review.model).toBe('gpt-test');
    fs.unlinkSync(path.join(process.env.PIPELINE_DATA_DIR!, 'DM-2.events.jsonl'));
    expect(() => ensureExecutionPlan(state)).toThrow('无法安全迁移');
  });
  it('switch mailbox survives normal ticket saves and waits for the next stage', () => {
    const state = loadTicket(repo, 'DM-3', 'implement'); saveTicket(state);
    const plan = freezePlan(repo); plan.review.model = 'haiku';
    appendEvent({ ticket: 'DM-3', type: 'stage.start', stage: 'implement', summary: '阶段 implement' });
    const request = queueExecutionSwitch(state, plan, 'tester', 'different reviewer');
    saveTicket(state);
    expect(pendingSwitch('DM-3')?.reason).toBe('different reviewer');
    expect(switchReady(state, request)).toBe(false);
    expect(switchReady({ ...state, cursor: 'review' }, request)).toBe(true);
    clearExecutionSwitch('DM-3', 'older-request'); expect(pendingSwitch('DM-3')).toBeTruthy();
    clearExecutionSwitch('DM-3', request.requestId!); expect(pendingSwitch('DM-3')).toBeUndefined();
  });
  it('blocked validation costs nothing and cannot create activation evidence', async () => {
    const profile = { ...initialConfiguration().profiles[2], provider: 'custom-provider' };
    const run = vi.spyOn(engineNamed('opencode'), 'runJson');
    const report = await validateProfile(profile, ['run']);
    expect(report.ok).toBe(false); expect(report.costUsd).toBe(0); expect(run).not.toHaveBeenCalled();
    expect(report.errors.join()).toContain('未冻结');
  });
  it('freezes the built-in free OpenCode model for every entry while preserving overrides', () => {
    delete process.env.PIPELINE_OPENCODE_MODEL;
    const c = initialConfiguration();
    expect(c.global.default).toBe('legacy-codex');
    const profile = c.profiles.find(p => p.cli === 'opencode')!;
    for (const entry of ENTRIES) expect(freezeExecution(repo, entry, profile).model).toBe('opencode/space-bunny-free');
    const frozen = freezeExecution(repo, 'run', profile);
    process.env.PIPELINE_OPENCODE_MODEL = 'opencode/cat-jam-free';
    expect(freezeExecution(repo, 'run', profile).model).toBe('opencode/cat-jam-free');
    expect(frozen.model).toBe('opencode/space-bunny-free');
    expect(freezeExecution(repo, 'run', { ...profile, provider: 'custom', model: 'chosen' }).model).toBe('custom/chosen');
    expect(freezeExecution(repo, 'run', { ...profile, provider: 'custom', model: 'custom/chosen' }).model).toBe('custom/chosen');
  });
  it.each(['codex-cli 0.161.0', 'unknown-version'])('rejects MXC on %s before any native model request', async version => {
    const run = vi.spyOn(engineNamed('codex'), 'runJson');
    const report = await validateProfile({ id: 'mxc-test', name: 'MXC', cli: 'codex', model: 'gpt-test', constraintMode: 'native', state: 'draft', parameters: { windowsSandbox: 'mxc' } }, ['run'], { version: async () => version, browser: false });
    expect(report.ok).toBe(false); expect(report.errors.join()).toContain('0.162.0');
    expect(report.costUsd).toBe(0); expect(run).not.toHaveBeenCalled();
  });
  it('stale probe results cannot activate edited content', () => {
    const c = initialConfiguration(); const profile = { ...active('probe'), state: 'draft' as const, validation: undefined }; c.profiles.push(profile); writeConfiguration(c, 0);
    const changed = readConfiguration(); changed.profiles[3].model = 'opus'; writeConfiguration(changed, 1);
    expect(() => recordValidation(profile, 1, ['run'], { ok: true, profileId: 'probe', at: '', checks: [], errors: [], costUsd: 0, cliVersion: 'test' })).toThrow('配置已变更');
    expect(readConfiguration().profiles[3].state).toBe('draft');
  });
});

describe('strict CLI protocol and shared knowledge', () => {
  it('OpenCode missing step_finish needs exact persisted completion, not merely exit zero or previous output', () => {
    const stream = JSON.stringify({ type: 'text', sessionID: 'ses-new', part: { messageID: 'msg-new', text: 'finished nonce' } });
    const saved = { info: { id: 'ses-new' }, messages: [{ id: 'msg-new', type: 'assistant', finish: 'stop', cost: 0, time: { created: 1, completed: 2 }, content: [{ type: 'text', text: 'finished nonce' }] }, { id: 'idle', type: 'idle', outcome: 'succeeded', time: { created: 3 } }] };
    expect(completeOpenCodeFromExport(stream, saved).complete).toBe(true);
    expect(completeOpenCodeFromExport(stream + '\n', saved).complete).toBe(true);
    expect(completeOpenCodeFromExport(stream, { ...saved, info: { id: 'ses-other' } }).complete).toBe(false);
    const pending = structuredClone(saved); delete (pending.messages[0].time as { completed?: number }).completed;
    expect(completeOpenCodeFromExport(stream, pending).complete).toBe(false);
    const wrong = structuredClone(saved); wrong.messages[0].id = 'msg-old';
    expect(completeOpenCodeFromExport(stream, wrong).complete).toBe(false);
    const failed = structuredClone(saved); failed.messages[1].outcome = 'failed';
    expect(completeOpenCodeFromExport(stream, failed).complete).toBe(false);
  });
  it('OpenCode prefixes slash-containing model IDs without duplicating an explicit provider', () => {
    const profile = { id: 'router', name: 'router', cli: 'opencode' as const, provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5', parameters: {}, state: 'draft' as const };
    expect(freezeExecution(repo, 'run', profile).model).toBe('openrouter/anthropic/claude-sonnet-4-5');
    expect(freezeExecution(repo, 'run', { ...profile, model: 'openrouter/anthropic/claude-sonnet-4-5' }).model).toBe('openrouter/anthropic/claude-sonnet-4-5');
  });
  it('native OpenCode permits recovered tool errors only alongside verified final completion', () => {
    const stream = [JSON.stringify({ type: 'tool_use', sessionID: 'session', part: { tool: 'read', state: { status: 'error', error: 'missing canary' } } }),
      JSON.stringify({ type: 'text', sessionID: 'session', part: { messageID: 'final', text: 'DENIED' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'session', part: { messageID: 'final', reason: 'stop', cost: 0 } })].join('\n');
    expect(summarizeOpenCode(stream).error).toBe('missing canary');
    expect(summarizeOpenCode(stream, true)).toMatchObject({ complete: true, text: 'DENIED', toolErrors: ['missing canary'] });
    expect(summarizeOpenCode(stream, true).error).toBeUndefined();
    expect(summarizeOpenCode(stream.split('\n')[0], true).error).toBeDefined();
    expect(summarizeOpenCode(stream + '\n' + JSON.stringify({ type: 'error', error: { message: 'provider failed' } }), true).error).toBe('provider failed');
  });
  it('native OpenCode preserves declared providers and pins its own permission agents', async () => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { existing: { env: ['KEY_REF'] } }, agents: { extra: { description: 'existing' } } });
    const stream = [JSON.stringify({ type: 'text', sessionID: 'session', part: { messageID: 'final', text: 'ready' } }), JSON.stringify({ type: 'step_finish', sessionID: 'session', part: { messageID: 'final', reason: 'stop', cost: 0 } })].join('\n');
    const spy = vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stdout: stream, stderr: '' });
    await engineNamed('opencode').runText({ cwd: repo, prompt: 'test', model: 'existing/model', tools: 'Read', maxTurns: 4, budgetUsd: 3, constraintMode: 'native' });
    const config = JSON.parse(spy.mock.calls[0][2].env!.OPENCODE_CONFIG_CONTENT!);
    expect(config.providers.existing).toEqual({ env: ['KEY_REF'] });
    const executor = Object.keys(config.agents).find(name => name.endsWith('-executor'))!;
    expect(config.agents[executor].permissions).toContainEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(config.agents[executor].permissions).toContainEqual({ action: 'read', resource: '*', effect: 'allow' });
    expect(config.agents[executor].steps).toBe(4);
  });
  it('OpenCode allows prerequisite reads but rejects direct, opaque or aliased parent secret reads', () => {
    const read = (input: unknown, metadata?: { rawInput?: unknown; content?: unknown }) => ({ type: 'tool_use', part: { tool: 'read', state: { input, metadata } } });
    expect(openCodeParentReadsSecret([read({ path: 'AGENTS.md' })], 'secret-value')).toBe(false);
    expect(openCodeParentReadsSecret([read({}, { rawInput: '{"path":"child-secret.txt"}' })], 'secret-value')).toBe(true);
    expect(openCodeParentReadsSecret([read({ path: 'alias.txt' }, { content: [{ text: 'secret-value' }] })], 'secret-value')).toBe(true);
    expect(openCodeParentReadsSecret([read(undefined)], 'secret-value')).toBe(true);
  });
  it('Claude limits count parent tool rounds rather than a terminal loop or child output', () => {
    const events = [{ type: 'system', subtype: 'init', tools: ['Read'] }, { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read' }] } }, { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read' }] } }, { type: 'assistant', parent_tool_use_id: 'child', message: { id: 'm2', content: [{ type: 'tool_use', name: 'Read' }] } }, { type: 'result', subtype: 'error_max_turns', num_turns: 2 }];
    expect(claudeTrace(events.map(e => JSON.stringify(e)).join('\n'))).toEqual({ tools: ['Read'], requestedTools: ['Read', 'Read'], toolRounds: 1, resultSubtype: 'error_max_turns' });
  });
  it('nonzero Claude exits remain failures while retaining valid reported usage', async () => {
    vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 1, stderr: 'failed', stdout: JSON.stringify({ type: 'result', is_error: false, session_id: 'paid-session', num_turns: 2, total_cost_usd: 0.42, result: 'partial text' }) });
    const result = await runClaudeText({ cwd: repo, prompt: 'test', tools: 'Read', model: 'sonnet', maxTurns: 2, budgetUsd: 1 });
    expect(result.isError).toBe(true);
    expect(result.costUsd).toBe(0.42);
    expect(result.sessionId).toBe('paid-session');
  });
  it('probe errors without usage report a partial known total rather than claiming zero total cost', async () => {
    vi.spyOn(identity, 'commandIdentity').mockReturnValue('test-cli');
    const engine = { ...engineNamed('claude'), runJson: vi.fn().mockRejectedValue(new Error('CLI timed out after a request')) };
    const report = await validateProfile(active('probe'), ['run'], { engine, version: async () => 'test-version' });
    expect(report.ok).toBe(false);
    expect(report.costStatus).toBe('partial');
    expect(report.errors).toContain('CLI timed out after a request');
  });
  it('an Agent call plus a parent Read cannot authorize independent-child capability', async () => {
    vi.spyOn(identity, 'commandIdentity').mockReturnValue('test-cli');
    let nonce = '';
    const event = (names: string[], subtype = 'success') => [JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'] }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: names.map(name => ({ type: 'tool_use', name })) } }),
      JSON.stringify({ type: 'result', subtype })].join('\n');
    const engine: ReturnType<typeof engineNamed> = { ...engineNamed('claude'),
      async runJson(opts) {
        const value = (opts.schema as { properties: { nonce: { const: string } } }).properties.nonce.const;
        return { envelope: { is_error: false, total_cost_usd: 0, num_turns: 1, session_id: 'test-session', permission_denials: [], structured_output: { nonce: value } as never }, rawStdout: '' };
      },
      async runText(opts) {
        let text = 'READY', isError = false, rawStdout = event([]);
        if (opts.prompt.startsWith('Remember')) nonce = opts.prompt.match(/marker ([\w-]+)/)![1];
        if (opts.resumeSessionId) text = nonce;
        if (opts.maxTurns === 1) { isError = true; rawStdout = event(['Read'], 'error_max_turns'); }
        if (opts.budgetUsd === 0.000001) { isError = true; rawStdout = event(['Read'], 'error_max_budget_usd'); }
        if (opts.prompt.startsWith('Make exactly one fresh')) {
          text = fs.readFileSync(path.join(opts.cwd, 'child-marker.txt'), 'utf8');
          rawStdout = event(['Read', 'Agent']);
        }
        return { text, isError, rawStdout, sessionId: opts.resumeSessionId || 'test-session', turns: 1, costUsd: 0 };
      } };
    const report = await validateProfile(active('child-probe'), ['implement'], { engine, version: async () => 'test-version' });
    expect(report.ok).toBe(false);
    expect(report.errors).toContain('子代理探测缺少原生工具调用与独立结果证据');
  });
  it('migration retains the actual CLI from a failed first attempt without a run record', () => {
    const state = loadTicket(repo, 'DM-20', 'review');
    delete state.executionPlan;
    appendEvent({ ticket: state.ticket, type: 'stage.start', stage: 'review', summary: 'start', payload: { model: 'codex:gpt-proven' } });
    expect(ensureExecutionPlan(state).executionPlan?.review.profile.cli).toBe('codex');
    expect(ensureExecutionPlan(state).executionPlan?.review.model).toBe('gpt-proven');
  });
  it('terminal failures release the switch boundary and UUID consumption preserves replacement requests', () => {
    const state = loadTicket(repo, 'DM-21', 'implement');
    appendEvent({ ticket: state.ticket, type: 'stage.start', stage: 'implement', summary: 'start' });
    const a = queueExecutionSwitch(state, freezePlan(repo), 'test', 'A');
    expect(switchReady(state, a)).toBe(false);
    expect(switchReady({ ...state, haltedReason: 'CLI failed' }, a)).toBe(true);
    const b = queueExecutionSwitch(state, freezePlan(repo), 'test', 'B');
    expect(a.requestId).not.toBe(b.requestId);
    clearExecutionSwitch(state.ticket, a.requestId!);
    expect(pendingSwitch(state.ticket)?.requestId).toBe(b.requestId);
    appendEvent({ ticket: state.ticket, type: 'error', stage: 'implement', summary: 'CLI failed' });
    expect(queueExecutionSwitch(state, freezePlan(repo), 'test', 'recover').afterStage).toBe('');
  });
  it('probe plans disclose all grouped calls and blocked profiles have zero model calls', () => {
    const p = active('all');
    const plan = validationPlan(p, ['run', 'review', 'implement']);
    expect(plan.calls).toBe(20);
    expect(plan.contexts).toHaveLength(3);
    expect(plan.budgetSemantics).toContain('不是总费用硬上限');
    expect(validationPlan({ ...initialConfiguration().profiles.find(p => p.cli === 'opencode')!, provider: 'custom-provider' }, ['run']).calls).toBe(0);
  });
  it('optional browser proof changes the paid plan and remains required for browser-enabled snapshots', () => {
    const profile = active('browser-scope');
    profile.validation!.checks = [];
    const normal = validationPlan(profile, ['review']);
    const scoped = validationPlan(profile, ['review'], { browser: false });
    expect(normal.calls - scoped.calls).toBe(1);
    expect(normal.token).not.toBe(scoped.token);
    expect(scoped.contexts[0].browserProbe).toBe(false);
    fs.writeFileSync(path.join(repo, 'docs/pipeline/PIPELINE.md'), '---\ne2e: playwright\n---\n');
    expect(() => assertExecutable(freezeExecution(repo, 'review', profile))).toThrow('浏览器能力验证证据');
  });
  it('Claude stream-json requires a final result and ignores intermediate tool events', () => {
    expect(() => parseClaudeOutput('{"type":"assistant","message":{}}')).toThrow('最终');
    expect(parseClaudeOutput('{"type":"assistant"}\n{"type":"result","is_error":false,"session_id":"s","num_turns":1,"total_cost_usd":0.1}').session_id).toBe('s');
    expect(() => parseClaudeOutput('{"type":"result","is_error":false,"session_id":"s"}')).toThrow('费用');
  });
  it('OpenCode takes final completed message, rejects partial/tool-error streams and unknown costs', () => {
    const event = (type: string, messageID: string, part: object) => JSON.stringify({ type, sessionID: 'ses-test', part: { messageID, ...part } });
    const transcript = [event('text', 'm1', { text: 'I will inspect' }), event('step_finish', 'm1', { reason: 'tool-calls', cost: 0.1 }), event('text', 'm2', { text: '{"ok":true}' }), event('step_finish', 'm2', { reason: 'stop', cost: 0.2 })].join('\n');
    expect(summarizeOpenCode(transcript).text).toBe('{"ok":true}');
    expect(summarizeOpenCode(transcript).costUsd).toBeCloseTo(0.3);
    expect(summarizeOpenCode(event('text', 'm2', { text: 'partial' })).error).toBeTruthy();
    expect(summarizeOpenCode(transcript + '\n' + event('tool_use', 'm2', { state: { status: 'error', error: 'permission denied' } })).error).toBe('permission denied');
    expect(summarizeOpenCode(event('text', 'm2', { text: 'ok' }) + '\n' + event('step_finish', 'm2', { reason: 'stop' })).costKnown).toBe(false);
    expect(summarizeOpenCode(transcript.replace('"cost":0.2', '"cost":null')).costKnown).toBe(false);
    expect(summarizeOpenCode(transcript.replace('"cost":0.2', '"cost":-1')).error).toContain('费用');
    expect(summarizeOpenCode('null').error).toContain('字段');
  });
  it('OpenCode v2 maps steps and deny-all policies with restricted children', () => {
    const c = openCodeConfiguration('Read,Agent', 7) as { skills: string[]; agents: Record<string, { steps: number; permissions: { action: string; resource: string; effect: string }[] }> };
    expect(c.skills[0]).toMatch(/pipeline-plugin\/skills$/);
    expect(c.agents['pipeline-executor'].steps).toBe(7);
    expect(c.agents['pipeline-executor'].permissions[0].effect).toBe('deny');
    expect(c.agents['pipeline-worker'].permissions.some(p => p.action === 'subagent')).toBe(false);
    expect(c.agents['pipeline-worker'].permissions.some(p => p.action === 'edit')).toBe(false);
  });
  it('generic rules and project knowledge have separate destinations; legacy suggestions remain readable', () => {
    const directory = path.join(repo, 'docs/pipeline/DM-5'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, '92-suggestions.json'), JSON.stringify({ agentsMd: [{ section: '## Rules', line: '- Always test' }], projectKnowledge: [{ section: '## Build', line: '- Use npm' }], claudeMd: [{ section: '## Legacy', line: '- Keep this fact' }] }));
    const { suggestions } = readSuggestions(repo, 'DM-5');
    applyClaudeMdSuggestions(repo, suggestions.claudeMd);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toContain('Always test');
    const knowledge = fs.readFileSync(path.join(repo, 'docs/pipeline/PROJECT-KNOWLEDGE.md'), 'utf8');
    expect(knowledge).toContain('Use npm'); expect(knowledge).toContain('Keep this fact');
    expect(sharedPrompt('task', repo)).toContain('Always test');
    expect(sharedPrompt('task', repo)).toContain('Use npm');
    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
  });
});
