import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexChildEvidence, validateProfile } from '../engine/validation.js';
import * as identity from '../engine/identity.js';
import { credentialContext, assertRuntimeIdentity, commandIdentity, executionAccount } from '../engine/identity.js';
import { engineNamed } from '../engine/index.js';
import * as subprocess from '../engine/process.js';
import { withFileLock } from '../engine/fileLock.js';
import { formatCost, aggregateCostStatus } from '../cost.js';
import { writeAdhocRecord } from '../adhocLog.js';
import { generatePrototype } from '../prototype.js';
import { freezeExecution, freezePlan, initialConfiguration, writeConfiguration, type AgentProfile } from '../engine/configuration.js';
import { loadTicket, saveTicket, readSnapshot } from '../ticket.js';
import { queueExecutionSwitch } from '../engine/tickets.js';
import { runTicket } from '../ticketRunner.js';
import { readEvents } from '../events.js';
import { verifiedOpenCodeResult } from '../engine/opencode.js';
import * as engines from '../engine/index.js';
import { classifyCommand } from '../commands.js';
import { acceptanceTrace } from '../../scripts/acceptance-trace.js';

let root: string;
const environment = { ...process.env };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-agent-audit-')); process.env.PIPELINE_DATA_DIR = path.join(root, 'data'); });
afterEach(() => { vi.restoreAllMocks(); process.env = { ...environment }; fs.rmSync(root, { recursive: true, force: true }); });

describe('Astra acceptance regressions', () => {
  it('does not invalidate OpenCode when unrelated native Codex credentials rotate, while explicit references remain bound', () => {
    const codexHome = path.join(root, 'native-codex'); fs.mkdirSync(codexHome); process.env.CODEX_HOME = codexHome;
    const auth = path.join(codexHome, 'auth.json'); fs.writeFileSync(auth, '{"token":"fake-a"}');
    const opencode = credentialContext(undefined, 'opencode', root), codex = credentialContext(undefined, 'codex', root);
    fs.writeFileSync(auth, '{"token":"fake-b"}'); process.env.CODEX_NATIVE_TEST_KEY = 'native-test-a';
    expect(credentialContext(undefined, 'opencode', root)).toBe(opencode);
    expect(credentialContext(undefined, 'codex', root)).not.toBe(codex);
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { custom: { env: ['CODEX_NATIVE_TEST_KEY'] } } });
    const explicit = credentialContext(undefined, 'opencode', root); process.env.CODEX_NATIVE_TEST_KEY = 'native-test-b';
    expect(credentialContext(undefined, 'opencode', root)).not.toBe(explicit);
  });
  it('redacts credentials while preserving parseable native usage evidence and token limits', () => {
    process.env.AUDIT_API_KEY = 'audit-secret'; process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '8192';
    const trace = acceptanceTrace(root, () => {});
    trace.capture({ command: 'mock-cli', cwd: root, code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', text: 'audit-secret', maxOutputTokens: 8192, usage: { output_tokens: 8192 } }) + '\n' });
    const evidence = JSON.parse(fs.readFileSync(path.join(root, trace.calls[0].file), 'utf8'));
    const native = JSON.parse(evidence.stdout);
    expect(native.text).toBe('[REDACTED_CREDENTIAL]'); expect(native.maxOutputTokens).toBe(8192); expect(native.usage.output_tokens).toBe(8192);
    expect(trace.errors).toEqual([]);
  });
  it('applies an explicit boundary switch when an old saved plan is no longer executable', async () => {
    const configuration = initialConfiguration(); configuration.global.default = 'legacy-claude'; writeConfiguration(configuration, 0);
    const state = loadTicket(root, 'AUD-4', 'plan');
    const replacement = structuredClone(state.executionPlan!);
    state.haltedReason = 'Historical plan halted';
    state.executionPlan!.plan.profile = { id: 'old-open', name: 'Historical OpenCode', cli: 'opencode', model: 'old/model', credentialRef: 'OLD_NATIVE_KEY', parameters: {}, state: 'draft' };
    saveTicket(state);
    queueExecutionSwitch(state, replacement, 'fixture-user', 'Explicit recovery of historical unsupported credentialRef');
    saveTicket({ ...state, haltedReason: undefined }); // Explicit user continuation.
    const call = vi.spyOn(engineNamed('claude'), 'runJson').mockResolvedValue({ envelope: { is_error: false, session_id: 'unit-native-call', num_turns: 1, total_cost_usd: 0, permission_denials: [], structured_output: {
      stage: 'plan', status: 'BLOCKED', handoff_path: 'docs/pipeline/AUD-4/20-plan.md', summary_for_card: 'Controlled unit stop', blocked_reason: 'Unit test stops after verifying the execution snapshot',
    } }, rawStdout: '' });
    await runTicket({ repo: root, ticket: 'AUD-4', lane: 'full', requirement: 'Unit historical recovery fixture', port: { async notify() {}, async confirmGate() { return { approved: false, note: 'Unit stop' }; }, async askQuestions() { return []; }, close() {} } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(readSnapshot('AUD-4')!.executionPlan!.plan.profile.cli).toBe('claude');
    expect(readEvents('AUD-4').some(event => event.type === 'human.message' && event.summary.includes('执行配置切换'))).toBe(true);
    expect(readSnapshot('AUD-4')!.executionSwitchPrevious!.plan.profile.credentialRef).toBe('OLD_NATIVE_KEY');
  });
  it('freezes external and inline file credentials including environment-expanded paths', () => {
    const directory = path.join(root, 'native-config'); fs.mkdirSync(directory);
    const config = path.join(directory, 'external.json'), key = path.join(directory, 'key.txt');
    fs.writeFileSync(path.join(root, 'key.txt'), 'decoy-from-wrong-cwd');
    fs.writeFileSync(key, 'key-a'); fs.writeFileSync(config, '{"providers":{"local":{"settings":{"apiKey":"{file:key.txt}"}}}}');
    process.env.OPENCODE_CONFIG = config;
    const first = credentialContext(undefined, 'opencode', root);
    fs.writeFileSync(key, 'key-b'); expect(credentialContext(undefined, 'opencode', root)).not.toBe(first);
    delete process.env.OPENCODE_CONFIG;
    process.env.AUDIT_FILE_PATH = key.replace(/\\/g, '/');
    process.env.OPENCODE_CONFIG_CONTENT = '{"providers":{"local":{"settings":{"apiKey":"{file:{env:AUDIT_FILE_PATH}}"}}}}';
    const second = credentialContext(undefined, 'opencode', root);
    fs.writeFileSync(key, 'key-c'); expect(credentialContext(undefined, 'opencode', root)).not.toBe(second);
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    process.env.OPENCODE_CONFIG_CONTENT = '{"providers":{"local":{"settings":{"apiKey":"{file:~/native-config/key.txt}"}}}}';
    const third = credentialContext(undefined, 'opencode', root);
    fs.writeFileSync(key, 'key-d'); expect(credentialContext(undefined, 'opencode', root)).not.toBe(third);
  });
  it('preserves known OpenCode failure usage and marks the unreported final portion', async () => {
    const stdout = [
      { type: 'text', sessionID: 'failed-native-session', part: { messageID: 'first', text: 'working' } },
      { type: 'step_finish', sessionID: 'failed-native-session', part: { messageID: 'first', reason: 'tool-calls', cost: 0.25 } },
      { type: 'error', sessionID: 'failed-native-session', error: { message: 'fatal provider failure' } },
    ].map(event => JSON.stringify(event)).join('\n');
    await expect(verifiedOpenCodeResult({ code: 1, stderr: '', stdout }, { command: 'mock', cwd: root, env: {} })).rejects.toMatchObject({
      name: 'CliExecutionError', envelope: { is_error: true, session_id: 'failed-native-session', num_turns: 1, total_cost_usd: 0.25, costStatus: 'partial' },
    });
  });
  it('freezes the classification engine once across a failed attempt and changed defaults', async () => {
    const runJson = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue({ envelope: { structured_output: { kind: 'dashboard', confidence: 0.9 } } });
    const original: import('../engine/types.js').Engine = { name: 'claude', runJson, runText: vi.fn(), runStage: vi.fn() };
    const changed: import('../engine/types.js').Engine = { name: 'opencode', runJson: vi.fn().mockRejectedValue(new Error('new CLI should never run')), runText: vi.fn(), runStage: vi.fn() };
    const lookup = vi.spyOn(engines, 'engineFor').mockReturnValueOnce(original).mockReturnValue(changed);
    const result = await classifyCommand('查看看板', [], root);
    expect(result.command.kind).toBe('dashboard'); expect(runJson).toHaveBeenCalledTimes(2); expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('selects profiles from the logical project but freezes the actual worktree sources', () => {
    const main = path.join(root, 'main'), worktree = path.join(root, 'worktree');
    for (const directory of [main, worktree]) { fs.mkdirSync(path.join(directory, '.codex'), { recursive: true }); fs.writeFileSync(path.join(directory, '.codex/config.toml'), 'model_provider="same"'); }
    const configuration = initialConfiguration(); configuration.projects[main] = { default: 'legacy-codex' };
    writeConfiguration(configuration, 0);
    const project = { alias: 'logical', repo: main } as import('../projects.js').Project;
    const ticket = loadTicket(worktree, 'AUD-2', 'plan', project);
    expect(ticket.executionPlan!.plan.profile.cli).toBe('codex');
    expect(ticket.executionPlan!.plan.nativeContext).toBe(credentialContext(undefined, 'codex', worktree));
    expect(ticket.executionPlan!.plan.nativeContext).not.toBe(credentialContext(undefined, 'codex', main));
    expect(freezePlan(main, configuration, worktree).plan.nativeContext).toBe(ticket.executionPlan!.plan.nativeContext);
  });
  it('requires a matching completed child result and rejects parent tools or unrelated waits', () => {
    const events = [
      { type: 'thread.started', thread_id: 'parent' },
      { type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed', sender_thread_id: 'parent', receiver_thread_ids: ['child'], prompt: 'Read child-secret.txt' } },
      { type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait', status: 'completed', sender_thread_id: 'parent', receiver_thread_ids: ['child'], agents_states: { child: { status: 'completed', message: 'hidden-proof' } } } },
    ];
    expect(codexChildEvidence(events, 'hidden-proof').independent).toBe(true);
    expect(codexChildEvidence(events.slice(0, 2), 'hidden-proof').independent).toBe(false);
    expect(codexChildEvidence([...events, { type: 'item.completed', item: { type: 'command_execution' } }], 'hidden-proof')).toEqual({ independent: false, parentSecretRead: true });
    expect(codexChildEvidence([events[0], events[1], { ...events[2], item: { ...events[2].item, receiver_thread_ids: ['unrelated'] } }], 'hidden-proof').independent).toBe(false);
    expect(codexChildEvidence([events[0], events[1], { ...events[2], item: { ...events[2].item, agents_states: { child: { status: 'errored', message: 'hidden-proof' } } } }], 'hidden-proof').independent).toBe(false);
  });
  it('hashes external and inherited project OpenCode configuration contents', () => {
    const file = path.join(root, 'provider.json'); process.env.OPENCODE_CONFIG = file;
    fs.writeFileSync(file, '{"providers":{"local":{"baseURL":"http://127.0.0.1:1111"}}}');
    const before = credentialContext(undefined, 'opencode', root);
    fs.writeFileSync(file, '{"providers":{"local":{"baseURL":"http://127.0.0.1:2222"}}}');
    expect(credentialContext(undefined, 'opencode', root)).not.toBe(before);
    const child = path.join(root, 'child'); fs.mkdirSync(child);
    const prior = credentialContext(undefined, 'opencode', child);
    fs.writeFileSync(path.join(root, 'opencode.jsonc'), '{"permissions":[]}');
    expect(credentialContext(undefined, 'opencode', child)).not.toBe(prior);
  });
  it('rejects changed project configuration against the frozen runtime context before execution', async () => {
    process.env.PIPELINE_CODEX_BIN = process.execPath;
    vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stdout: 'native-test-version', stderr: '' });
    const profile: AgentProfile = { id: 'native-codex', name: 'Codex', cli: 'codex', model: 'explicit-model', state: 'active', parameters: {}, validation: {
      fingerprint: '', at: 'test', entries: ['run'], checks: [], cliVersion: 'native-test-version', account: executionAccount(), command: commandIdentity('codex'), credentialContext: credentialContext(undefined, 'codex'),
    } };
    const context = credentialContext(undefined, 'codex', root);
    await expect(assertRuntimeIdentity(profile, root, context)).resolves.toBeUndefined();
    fs.mkdirSync(path.join(root, '.codex')); fs.writeFileSync(path.join(root, '.codex/config.toml'), 'model_provider="different"');
    await expect(assertRuntimeIdentity(profile, root, context)).rejects.toThrow('项目原生配置');
  });
  it('keeps preflight fingerprints consistent in a mixed CLI configuration environment', async () => {
    process.env.OPENCODE_CONFIG = path.join(root, 'external.json'); fs.writeFileSync(process.env.OPENCODE_CONFIG, '{}');
    vi.spyOn(identity, 'commandIdentity').mockReturnValue('mock-cli');
    let nonce = '';
    const engine: import('../engine/types.js').Engine = { name: 'codex', runStage: engineNamed('codex').runStage,
      async runJson(opts) {
        const match = /"nonce":"([^"]+)"/.exec(opts.prompt);
        return { envelope: { is_error: false, session_id: 'probe-session', num_turns: 1, total_cost_usd: 0, costStatus: 'unknown', permission_denials: [], structured_output: (match ? { nonce: match[1] } : { denied: true }) as unknown as import('../types.js').StageResult }, rawStdout: '' };
      },
      async runText(opts) {
        if (!opts.resumeSessionId) nonce = /Remember nonce ([^.]+)\./.exec(opts.prompt)![1];
        return { text: nonce, costUsd: 0, turns: 1, sessionId: 'probe-session', costStatus: 'unknown', isError: false };
      },
    };
    const report = await validateProfile({ id: 'mixed-cli', name: 'Mixed', cli: 'codex', model: 'explicit-model', constraintMode: 'native', parameters: {}, state: 'draft' }, ['run'], { engine, version: async () => 'mock-version', browser: false });
    expect(report.errors).toEqual([]); expect(report.ok).toBe(true);
  });
  it('rejects unbound credential references before making any native model call', async () => {
    process.env.AUDIT_SELECTED_KEY = 'selected-test-key';
    const run = vi.spyOn(subprocess, 'runProcess');
    const opts = { cwd: root, prompt: 'test', tools: 'Read', maxTurns: 1, budgetUsd: 0, model: 'local/model', credentialRef: 'AUDIT_SELECTED_KEY', constraintMode: 'native' as const };
    await expect(engineNamed('codex').runText(opts)).rejects.toThrow('不支持 credentialRef');
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { local: { env: ['OTHER_KEY'] } } });
    await expect(engineNamed('opencode').runText(opts)).rejects.toThrow('不支持 credentialRef');
    expect(run).not.toHaveBeenCalled();
  });
  it('freezes arbitrary native OpenCode credential environment references', async () => {
    process.env.AUDIT_SELECTED_KEY = 'selected-test-key';
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { local: { env: ['AUDIT_SELECTED_KEY'] } } });
    const run = vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stderr: '', stdout: [
      { type: 'text', sessionID: 'bound-session', part: { messageID: 'final', text: 'actual result' } },
      { type: 'step_finish', sessionID: 'bound-session', part: { messageID: 'final', reason: 'stop', cost: 0.1 } },
    ].map(event => JSON.stringify(event)).join('\n') });
    const digest = credentialContext(undefined, 'opencode');
    process.env.AUDIT_SELECTED_KEY = 'changed-native-key';
    expect(credentialContext(undefined, 'opencode')).not.toBe(digest);
    await engineNamed('opencode').runText({ cwd: root, prompt: 'test', tools: 'Read', maxTurns: 1, budgetUsd: 0, model: 'local/model', constraintMode: 'native' });
    expect(run.mock.calls[0][2].env!.AUDIT_SELECTED_KEY).toBe('changed-native-key');
    expect(JSON.parse(run.mock.calls[0][2].env!.OPENCODE_CONFIG_CONTENT!).providers.local.env).toEqual(['AUDIT_SELECTED_KEY']);
    expect(fs.readdirSync(root)).not.toContain('opencode.json');
  });
  it('persists unknown costs in adhoc artifacts and renders incomplete totals honestly', () => {
    const file = writeAdhocRecord({ at: '2026-10-12T00:00:00Z', project: 'fixture', command: 'audit', prompt: 'test', output: 'actual result', costUsd: 0, costStatus: 'unknown', turns: 1, seconds: 1, isError: false, sessionId: 'native-session' })!;
    expect(fs.readFileSync(file, 'utf8')).toContain('成本：费用未知');
    expect(fs.readFileSync(file, 'utf8')).toContain('native-session');
    expect(formatCost(0, 'unknown')).not.toContain('$0');
    expect(aggregateCostStatus([{ costStatus: 'reported' }, { costStatus: 'unknown' }])).toBe('partial');
    expect(aggregateCostStatus([{ costStatus: 'unknown' }])).toBe('unknown');
  });
  it('returns real prototype session and pricing status even when no artifact is created', async () => {
    vi.spyOn(engineNamed('claude'), 'runText').mockResolvedValue({ text: 'no artifact', costUsd: 0, costStatus: 'unknown', turns: 2, sessionId: 'prototype-native-session', isError: false });
    const execution = freezeExecution(root, 'prototype', { id: 'legacy-claude', name: 'Claude', cli: 'claude', parameters: {}, state: 'legacy' });
    expect(await generatePrototype(root, 'AUD-1', execution)).toMatchObject({ ok: false, costStatus: 'unknown', sessionId: 'prototype-native-session', turns: 2 });
  });
  it('does not reclaim dead or live locks through a non-atomic read/unlink', () => {
    const file = path.join(root, 'config.lock');
    vi.spyOn(process, 'kill').mockImplementation((pid) => { if (pid === 123456789) throw Object.assign(new Error('dead'), { code: 'ESRCH' }); return true; });
    fs.writeFileSync(file, JSON.stringify({ pid: 123456789, token: 'dead-owner' }));
    expect(() => withFileLock(file, () => 42)).toThrow('不会自动回收'); expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'live-owner' }));
    expect(() => withFileLock(file, () => 0)).toThrow('不会自动回收');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe('live-owner');
  });
});
