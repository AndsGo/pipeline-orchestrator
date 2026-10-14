import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { assertRequirements, ENTRY_DEFAULTS, executionConstraints, freezeExecution, profileFingerprint, readConfiguration, writeConfiguration, type AgentProfile, type Entry, type ExecutionSnapshot } from './configuration.js';
import { engineNamed } from './index.js';
import type { Engine } from './types.js';
import { writeClaudeMcpConfig } from './e2e.js';
import { cliVersion, commandIdentity, credentialContext, executionAccount } from './identity.js';
import { CliExecutionError } from './errors.js';
import { claudeTrace } from '../runner.js';
import { namedChildFromRollouts, type NamedChildEvidence } from './codexChild.js';
import { sandboxFor } from './codex.js';
export { cliVersion } from './identity.js';

export interface ValidationReport {
  ok: boolean; profileId: string; at: string; checks: string[]; errors: string[]; costUsd: number;
  cliVersion?: string; command?: string; credentialContext?: string; resolved?: Partial<Record<Entry, string>>;
  probeCredentialContext?: string;
  costStatus?: 'reported' | 'partial' | 'unknown';
  changedIdentitySources?: string[];
  constraints?: ReturnType<typeof executionConstraints>[];
  childEvidence?: { secretReturned: boolean; parentSecretRead: boolean; parentFileReadsDisabled?: boolean; namedTask?: NamedChildEvidence; events: { type?: string; itemType?: string; tool?: string; name?: string; status?: string; errorKind?: string; keys: string[] }[] };
}
const browserProbe = (s: ExecutionSnapshot, enabled = true) => enabled && ['review', 'acceptance', 'mr-review'].includes(s.entry);
const probeCalls = (s: ExecutionSnapshot, browser = true) => (s.profile.cli === 'claude' ? 6 : s.profile.cli === 'opencode' && s.constraintMode === 'native' ? 6 : 4)
  + (s.entry === 'implement' ? 1 : 0)
  + (browserProbe(s, browser) ? s.profile.cli === 'opencode' && s.constraintMode === 'native' ? 2 : 1 : 0);
const probeGroup = (s: ExecutionSnapshot, browser = true) => s.profile.cli === 'codex' && s.constraintMode === 'native'
  // Codex enforces a sandbox, not the requested turn/budget/tool-name limits.
  // Verify every distinct model/sandbox/child/browser context exactly once.
  ? JSON.stringify([s.model, sandboxFor(s.tools), s.entry === 'implement', browserProbe(s, browser)])
  : JSON.stringify([s.model, s.tools, s.maxTurns, s.budgetUsd, s.entry === 'implement', browserProbe(s, browser)]);
export function openCodeParentReadsSecret(events: { type?: string; part?: { tool?: string; state?: { status?: string; error?: string; input?: unknown; metadata?: { rawInput?: unknown; content?: unknown } } } }[], secret: string): boolean {
  return events.some(e => {
    if (e.type !== 'tool_use' || e.part?.tool !== 'read') return false;
    const state = e.part.state || {};
    if (JSON.stringify(state.metadata?.content || []).includes(secret)) return true;
    if (state.status === 'error' && /permission|denied/i.test(state.error || '')) return false;
    const args = JSON.stringify([state.input, state.metadata?.rawInput]);
    const unobserved = (!state.input || (typeof state.input === 'object' && !Object.keys(state.input).length)) && !state.metadata?.rawInput;
    return !!unobserved || /child-(?:secret|marker)\.txt/i.test(args) || JSON.stringify(state.metadata?.content || []).includes(secret);
  });
}
interface CodexChildEvent { type?: string; thread_id?: string; item?: { type?: string; tool?: string; status?: string; sender_thread_id?: string; receiver_thread_ids?: string[]; prompt?: string; agents_states?: Record<string, { status?: string; message?: string }> }; }
export function codexChildEvidence(events: CodexChildEvent[], secret: string): { independent: boolean; parentSecretRead: boolean } {
  // This probe requires no parent execution/MCP/file/search tools at all. Their
  // presence makes independent provenance unprovable, including aliased reads.
  const parentSecretRead = events.some(e => ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(e.item?.type || ''));
  const parent = events.find(e => e.type === 'thread.started')?.thread_id;
  const spawns = events.filter(e => e.type === 'item.completed' && e.item?.type === 'collab_tool_call' && e.item.tool === 'spawn_agent');
  const spawn = spawns[0]?.item;
  const child = spawn?.receiver_thread_ids?.[0];
  const index = events.indexOf(spawns[0]);
  const independent = !parentSecretRead && !!parent && spawns.length === 1 && spawn?.status === 'completed' && spawn.sender_thread_id === parent
    && spawn.receiver_thread_ids?.length === 1 && !!child && child !== parent && /child-(?:secret|marker)\.txt/.test(spawn.prompt || '') && !spawn.prompt?.includes(secret)
    && events.slice(index + 1).some(e => e.type === 'item.completed' && e.item?.type === 'collab_tool_call' && e.item.tool === 'wait' && e.item.status === 'completed'
      && e.item.sender_thread_id === parent && e.item.receiver_thread_ids?.includes(child) && e.item.agents_states?.[child]?.status === 'completed' && !!e.item.agents_states[child].message?.includes(secret));
  return { independent, parentSecretRead };
}
export function validationPlan(profile: AgentProfile, entries: Entry[], options: { browser?: boolean } = {}) {
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(e => !ENTRY_DEFAULTS[e])) throw new Error('验证入口不合法');
  const snapshots = entries.map(entry => freezeExecution(undefined, entry, profile));
  const groups = [...new Map(snapshots.map(s => [probeGroup(s, options.browser), s])).values()];
  const errors: string[] = [];
  for (const s of snapshots) { try { assertRequirements(s); } catch (e) { errors.push((e as Error).message); } }
  const contexts = groups.map(s => ({ entry: s.entry, model: s.model, browserProbe: browserProbe(s, options.browser), calls: probeCalls(s, options.browser), budgetPerCallUsd: s.profile.cli === 'claude' ? Math.min(s.budgetUsd, 0.3) : null, constraints: executionConstraints(s) }));
  const initializationCalls = profile.cli === 'codex' ? 1 : 0;
  const plan = { profile: profileFingerprint(profile), entries, contexts, initializationCalls, calls: errors.length ? 0 : initializationCalls + contexts.reduce((n, g) => n + g.calls, 0), errors: [...new Set(errors)], budgetSemantics: profile.cli === 'claude' ? '原生预算按已完成模型轮次检查，单轮可能超过设置值；此设置不是总费用硬上限。' : '此 CLI 没有原生金额上限；预算设置不限制模型调用费用，美元用量可能未知。OpenCode 调用数包含每个 JSON 探测最多一次原会话格式修正。' };
  return { ...plan, token: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}
/** Only an explicit user-triggered request can enter this paid probe. */
export async function validateProfile(profile: AgentProfile, entries: Entry[], dependencies: { engine?: Engine; version?: () => Promise<string>; browser?: boolean } = {}): Promise<ValidationReport> {
  const report: ValidationReport = { ok: false, profileId: profile.id, at: new Date().toISOString(), checks: [], errors: [], costUsd: 0, resolved: {}, costStatus: 'reported' };
  let root: string | undefined;
  let pendingCall = false;
  const identitySources: Record<string, string> = {};
  const probeSources: Record<string, string> = {};
  try {
    if (!entries.length || new Set(entries).size !== entries.length) throw new Error('请选择至少一个待验证入口，不允许重复');
    const snapshots = entries.map(entry => {
      if (!ENTRY_DEFAULTS[entry]) throw new Error(`未知入口 ${entry}`);
      const snapshot = freezeExecution(undefined, entry, profile);
      assertRequirements(snapshot);
      report.resolved![entry] = snapshot.model;
      return snapshot;
    });
    report.constraints = snapshots.map(executionConstraints);
    if (profile.cli !== 'claude') report.costStatus = 'unknown';
    report.cliVersion = await (dependencies.version ?? (() => cliVersion(profile.cli)))();
    if (profile.cli === 'codex' && profile.parameters.windowsSandbox === 'mxc') {
      const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(report.cliVersion);
      if (!version || (Number(version[1]) === 0 && Number(version[2]) < 162)) throw new Error('MXC 需要 Codex CLI 0.162.0 或更新版本；不自动切换沙箱');
    }
    report.command = commandIdentity(profile.cli);
    report.checks.push(`CLI 可执行：${report.cliVersion}`);
    const native = dependencies.engine ?? engineNamed(profile.cli);
    const invoke = async <T>(call: () => Promise<T>): Promise<T> => {
      pendingCall = true;
      try { const result = await call(); pendingCall = false; return result; }
      catch (e) { if (e instanceof CliExecutionError) { report.costUsd += e.envelope.total_cost_usd; pendingCall = false; } throw e; }
    };
    const engine: Engine = { ...native, runJson: opts => invoke(() => native.runJson(opts)), runText: opts => invoke(() => native.runText(opts)) };
    // Claude's native permission resolver treats 8.3 aliases and their long paths
    // as different workspaces; keep the cwd and child marker paths consistent.
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-agent-probe-')));
    // Native child sessions resolve project/worktree context; use a real isolated
    // repository rather than the CLI's shared global context for untracked folders.
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Isolated capability probe. Follow the explicit permission limits.\n');
    if (profile.cli === 'codex' && !dependencies.engine) {
      // The installed native runtime registers a new workspace-write project's
      // trust on startup. Initialize that owned project before taking baselines.
      const snapshot = snapshots[0];
      const initialized = await engine.runJson({ cwd: root, model: snapshot.model, tools: 'Write', maxTurns: 1, budgetUsd: Math.min(snapshot.budgetUsd, 0.3), timeoutMs: Math.min(snapshot.timeoutMs, 90000), windowsSandbox: profile.parameters.windowsSandbox, constraintMode: snapshot.constraintMode, effort: profile.parameters.effort,
        prompt: 'Native workspace initialization only. Return exactly {"ready":true}. Do not use any tools or modify files.', schema: { type: 'object', required: ['ready'], additionalProperties: false, properties: { ready: { type: 'boolean', const: true } } } });
      report.costUsd += initialized.envelope.total_cost_usd;
      if (initialized.envelope.is_error || (initialized.envelope.structured_output as unknown as { ready?: boolean })?.ready !== true) throw new Error('Codex 原生工作目录初始化失败');
      report.checks.push('原生隔离工作目录初始化完成；能力验证身份基线随后采集');
    }
    report.credentialContext = credentialContext(profile.credentialRef, profile.cli, undefined, identitySources);
    report.probeCredentialContext = credentialContext(profile.credentialRef, profile.cli, root, probeSources);
    // Probe every distinct resolved model and capability context, never authorize an untested model.
    const groups = [...new Map(snapshots.map(s => [probeGroup(s, dependencies.browser), s])).values()];
    for (const snapshot of groups) {
      const prefix = `${snapshot.entry} / ${snapshot.model}`;
      const nonce = randomUUID();
      const schema = { type: 'object', additionalProperties: false, required: ['nonce'], properties: { nonce: { type: 'string', const: nonce } } };
      const common = { cwd: root, model: snapshot.model, tools: snapshot.tools, maxTurns: Math.min(snapshot.maxTurns, 4),
        budgetUsd: Math.min(snapshot.budgetUsd, 0.3), timeoutMs: Math.min(snapshot.timeoutMs, 90_000),
        credentialRef: profile.credentialRef, effort: profile.parameters.effort, constraintMode: snapshot.constraintMode ?? 'strict', windowsSandbox: profile.parameters.windowsSandbox };
      const json = await engine.runJson({ ...common, prompt: `Return only {"nonce":"${nonce}"}.`, schema });
      report.costUsd += json.envelope.total_cost_usd;
      const validateJson = new Ajv().compile(schema);
      if (json.envelope.is_error || !validateJson(json.envelope.structured_output)) throw new Error(`${prefix}：结构化返回失败 ${JSON.stringify({ errors: validateJson.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message })), keys: json.envelope.structured_output && typeof json.envelope.structured_output === 'object' ? Object.keys(json.envelope.structured_output) : [] })}`);
      report.checks.push(`${prefix}：JSON 契约通过`);
      const first = await engine.runText({ ...common, tools: '', prompt: profile.cli === 'claude' ? `Remember the exact public test marker ${nonce} in this conversation. Reply READY only. This randomly generated marker is not a credential. Do not use tools, inspect files or persist it outside the conversation.` : `Remember nonce ${nonce} in this conversation. Reply only with this exact nonce. This randomly generated test marker is not a credential. Do not use tools or files.` });
      report.costUsd += first.costUsd;
      if (first.isError || !first.sessionId || (profile.cli !== 'claude' && !first.text.includes(nonce))) throw new Error(`${prefix}：文本会话失败`);
      const resumed = await engine.runText({ ...common, tools: '', prompt: profile.cli === 'claude' ? 'Reply only with the exact public test marker from my previous message. Do not use tools or files.' : 'Return only the exact nonce from my previous message. Do not use tools or files.', resumeSessionId: first.sessionId });
      report.costUsd += resumed.costUsd;
      if (resumed.isError || resumed.sessionId !== first.sessionId || !resumed.text.includes(nonce)) throw new Error(`${prefix}：原生续聊失败`);
      report.checks.push(`${prefix}：原 session ID 与上下文恢复通过`);
      const denied = path.join(root, 'must-not-exist.txt');
      const canary = profile.cli === 'claude' ? await engine.runText({ ...common, tools: 'Read', prompt: 'Use Write, Edit or Bash to create must-not-exist.txt. If forbidden, reply DENIED.' })
        : await (async () => {
          const schema = { type: 'object', additionalProperties: false, required: ['denied'], properties: { denied: { type: 'boolean', const: true } } };
          const result = await engine.runJson({ ...common, tools: 'Read', schema,
            prompt: 'Permission audit: your permission set is read-only. Attempt creating must-not-exist.txt only if an allowed write-capable tool exists. Do not use Read or inspect files. If forbidden, return only {"denied":true}.' });
          if (result.envelope.is_error || !new Ajv().compile(schema)(result.envelope.structured_output)) throw new Error(`${prefix}：原生只读 canary 未返回有效契约`);
          return { costUsd: result.envelope.total_cost_usd, isError: false, rawStdout: result.rawStdout };
        })();
      report.costUsd += canary.costUsd;
      const canaryTrace = claudeTrace(canary.rawStdout || '');
      const readOnly = profile.cli === 'claude' ? canaryTrace.tools?.length === 1 && canaryTrace.tools[0] === 'Read' && canaryTrace.requestedTools.every(t => t === 'Read') : true;
      const safeStop = !canary.isError || ['error_max_turns', 'error_max_budget_usd'].includes(canaryTrace.resultSubtype || '');
      if (fs.existsSync(denied) || !readOnly || !safeStop) throw new Error(`${prefix}：只读工具集合或实际调用越界，工具拒绝验证失败`);
      report.checks.push(`${prefix}：${profile.cli === 'claude' ? '只读工具集合' : '原生只读权限'}拒绝写入通过`);
      fs.writeFileSync(path.join(root, 'step-one.txt'), 'Read step-two.txt next.');
      fs.writeFileSync(path.join(root, 'step-two.txt'), randomUUID());
      if (profile.cli === 'claude') {
      const limited = await engine.runText({ ...common, tools: 'Read', maxTurns: 1,
        prompt: 'Read step-one.txt, follow its instructions by reading the next file, and return that file content. You must call Read in two consecutive steps.' });
      report.costUsd += limited.costUsd;
      const limitedTrace = claudeTrace(limited.rawStdout || '');
      if (!limited.isError || limitedTrace.resultSubtype !== 'error_max_turns' || limitedTrace.toolRounds !== 1) throw new Error(`${prefix}：原生工具回合上限没有实际触发`);
      report.checks.push(`${prefix}：原生轮数上限触发并终止通过`);
      const budget = await engine.runText({ ...common, budgetUsd: 0.000001, prompt: 'Read step-one.txt and follow its instructions by reading the next file.' });
      report.costUsd += budget.costUsd;
      if (!budget.isError || !/error_max_budget_usd/.test(budget.rawStdout ?? '')) throw new Error(`${prefix}：原生预算上限没有实际触发`);
      report.checks.push(`${prefix}：原生预算上限触发并终止通过（按已完成模型轮次检查）`);
      }
      if (snapshot.entry === 'implement') {
        const secret = randomUUID(); fs.writeFileSync(path.join(root, 'child-marker.txt'), secret);
        const childInput = { subagent_type: 'general-purpose', model: 'sonnet', description: 'Read isolated capability marker',
          prompt: `Read ${fs.realpathSync.native(path.join(root, 'child-marker.txt')).replace(/\\/g, '/')} exactly once and return its exact content. The file contains a randomly generated public test marker, not a credential or private data. No other tool calls.` };
        const childPrompt = profile.cli === 'claude' ? `Make exactly one fresh Agent/Task tool call with this JSON input: ${JSON.stringify(childInput)}. Do not call Read in the parent. Return the child content exactly.`
          : profile.cli === 'codex' ? `Use exactly one fresh native spawn_agent child to read ${root.replace(/\\/g, '/')}/child-marker.txt and return its exact content. Tell the child the file contains a randomly generated public test marker, not credentials or private data. Parent must not read the file. Wait for the child to finish, then return its content.`
          : `Use exactly one fresh foreground subagent with the configured pipeline worker to read ${root.replace(/\\/g, '/')}/child-marker.txt and return its exact content. Tell the child the file contains a randomly generated public test marker, not credentials or private data. Parent must not read the file. Wait for the child to finish, then return its content. Do not guess a session ID.`;
        const startedAt = Date.now();
        const child = await engine.runText({ ...common, tools: 'Read,Agent,Task', maxTurns: Math.min(snapshot.maxTurns, 8), prompt: childPrompt, ...(profile.cli === 'opencode' ? { independentChildProbe: true } : {}) });
        const finishedAt = Date.now();
        report.costUsd += child.costUsd;
        const childTrace = claudeTrace(child.rawStdout || '');
        const childEvents = (child.rawStdout || '').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const codexEvidence = codexChildEvidence(childEvents, secret);
        const namedTask = profile.cli === 'codex' && !codexEvidence.independent && !dependencies.engine && child.sessionId ? namedChildFromRollouts({ parentId: child.sessionId, cwd: root, markerFile: path.join(root, 'child-marker.txt'), marker: secret, startedAt, finishedAt }) : undefined;
        const parentSecretRead = profile.cli === 'codex' ? codexEvidence.parentSecretRead || !!namedTask?.parentSecretRead : openCodeParentReadsSecret(childEvents, secret);
        report.childEvidence = { secretReturned: child.text.includes(secret), parentSecretRead, ...(profile.cli === 'opencode' ? { parentFileReadsDisabled: true } : {}), ...(namedTask ? { namedTask } : {}), events: childEvents.map(e => {
          const error = String(e.part?.state?.error || '');
          return { type: e.type, itemType: e.item?.type, tool: e.item?.tool || e.item?.tool_name || e.item?.toolName || e.part?.tool, name: e.item?.name, status: e.part?.state?.status || e.item?.status,
            ...(error ? { errorKind: /agent.*(?:not found|unknown)|unknown.*agent/i.test(error) ? 'agent_unavailable' : /not found/i.test(error) ? 'file_missing' : /denied|permission/i.test(error) ? 'permission_denied' : 'other_tool_error' } : {}), keys: Object.keys(e.item || e.part || {}) };
        }) };
        const nativeChild = profile.cli === 'claude' ? childTrace.requestedTools.length > 0 && childTrace.requestedTools.every(t => ['Agent', 'Task'].includes(t))
          : profile.cli === 'codex' ? !parentSecretRead && (codexEvidence.independent || !!namedTask?.independent)
          : childEvents.some(e => e.type === 'tool_use' && e.part?.tool === 'subagent' && e.part.state?.status === 'completed') && !parentSecretRead;
        if (child.isError || !child.text.includes(secret) || !nativeChild) throw new Error('子代理探测缺少原生工具调用与独立结果证据');
        report.checks.push(`${prefix}：原生独立子代理调用通过`);
      }
      if (browserProbe(snapshot, dependencies.browser)) {
        const secret = randomUUID();
        const server = http.createServer((_req, res) => res.end(`<html><body><p id="proof">${secret}</p></body></html>`));
        const mcpFile = writeClaudeMcpConfig();
        try {
          await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
          const port = (server.address() as { port: number }).port;
          const browser = await engine.runJson({ ...common, tools: 'Read,mcp__playwright', maxTurns: Math.min(snapshot.maxTurns, 8), mcpConfigFile: mcpFile,
            prompt: `Use Playwright MCP to navigate http://127.0.0.1:${port}/ and read #proof. Return its text as nonce. Do not use any other network or shell tool.`,
            schema: { ...schema, properties: { nonce: { type: 'string' } } } });
          report.costUsd += browser.envelope.total_cost_usd;
          const output = browser.envelope.structured_output as unknown as { nonce?: string };
          if (browser.envelope.is_error || output?.nonce !== secret || !/(?:mcp__playwright__|playwright[_./-])?browser_(navigate|snapshot)/.test(browser.rawStdout)) throw new Error('浏览器探测缺少实际导航与页面读取证据');
          report.checks.push(`Playwright MCP：${prefix} 实际导航与页面读取通过`);
        } finally {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
          if (fs.existsSync(mcpFile)) fs.unlinkSync(mcpFile);
        }
      }
    }
    const finalSources: Record<string, string> = {};
    const finalContext = credentialContext(profile.credentialRef, profile.cli, undefined, finalSources);
    const finalProbeSources: Record<string, string> = {};
    const finalProbeContext = credentialContext(profile.credentialRef, profile.cli, root, finalProbeSources);
    report.changedIdentitySources = [...new Set([...Object.keys(identitySources), ...Object.keys(finalSources)])].filter(key => identitySources[key] !== finalSources[key])
      .concat([...new Set([...Object.keys(probeSources), ...Object.keys(finalProbeSources)])].filter(key => probeSources[key] !== finalProbeSources[key]).map(key => `probe:${key}`));
    if (report.credentialContext !== finalContext || report.probeCredentialContext !== finalProbeContext || report.command !== commandIdentity(profile.cli) || report.cliVersion !== await (dependencies.version ?? (() => cliVersion(profile.cli)))()) throw new Error(`探测期间 CLI 或认证／供应商上下文已变化，结果已丢弃，请重新验证${report.changedIdentitySources.length ? `（${report.changedIdentitySources.join(', ')}）` : ''}`);
    report.ok = true;
  } catch (e) { if (pendingCall) report.costStatus = 'partial'; report.errors.push((e as Error).message); }
  finally { if (root) fs.rmSync(root, { recursive: true, force: true }); }
  return report;
}
/** Probe evidence is written only if the profile is still exactly the tested revision. */
export function recordValidation(profile: AgentProfile, expectedRevision: number, entries: Entry[], report: ValidationReport): void {
  const current = readConfiguration();
  const target = current.profiles.find(p => p.id === profile.id);
  if (current.revision !== expectedRevision || !target || profileFingerprint(target) !== profileFingerprint(profile)) throw new Error('探测期间配置已变更，结果已丢弃，请重新验证');
  if (!report.ok || !report.cliVersion || !report.command || !report.resolved) return;
  target.state = 'active';
  target.validation = { fingerprint: profileFingerprint(target), at: report.at, entries, cliVersion: report.cliVersion,
    account: executionAccount(), checks: report.checks, command: report.command, credentialContext: report.credentialContext, resolved: report.resolved };
  writeConfiguration(current, expectedRevision);
}
