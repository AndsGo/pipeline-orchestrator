import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PLUGIN_DIR, RUNNER_SETTINGS, STAGE_EFFORT, STAGES } from './config.js';
import { e2eEnabledFor, writeClaudeMcpConfig } from './engine/e2e.js';
import { runProcess } from './engine/process.js';
import { wireSchema } from './schema.js';
import type { Envelope, Stage } from './types.js';
import { claudeRoleSettings } from './engine/claudeRoles.js';
import { cliVersion } from './engine/identity.js';

export interface RunOutcome { envelope: Envelope; rawStdout: string; }
export interface TextRunOpts {
  cwd: string; prompt: string; tools: string; model: string;
  maxTurns: number; budgetUsd: number; pluginDir?: string;
  resumeSessionId?: string; timeoutMs?: number; effort?: string; credentialRef?: string;
  /** Diagnostic native calls only; production engineFor clears this override. */
  settingSources?: string;
  constraintMode?: 'native' | 'strict';
  windowsSandbox?: import('./engine/configuration.js').WindowsSandbox;
  /** Production implement dispatch policy; scoped to this native invocation. */
  claudeRolePolicy?: boolean;
  /** Capability probe only: forbid parent file reads while its child may read. */
  independentChildProbe?: boolean;
}
export interface ClaudeJsonOpts extends TextRunOpts { schema: object; mcpConfigFile?: string; }
/** Only names are persisted, never credential values. */
export function credentialEnvironment(ref?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
  if (ref) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(ref) || !process.env[ref]) throw new Error(`CLI 凭据引用不可用：${ref}`);
    env.ANTHROPIC_API_KEY = process.env[ref];
  }
  return env;
}
const shq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
/** num_turns includes a terminal/blocked loop; limits apply to actual tool-use rounds. */
export function claudeTrace(stdout: string): { tools?: string[]; requestedTools: string[]; toolRounds: number; resultSubtype?: string } {
  const result: { tools?: string[]; requestedTools: string[]; toolRounds: number; resultSubtype?: string } = { requestedTools: [], toolRounds: 0 };
  const rounds = new Set<string>();
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools) && event.tools.every((t: unknown) => typeof t === 'string')) result.tools = event.tools;
    if (event.type === 'result') result.resultSubtype = event.subtype;
    if (event.type !== 'assistant' || event.parent_tool_use_id || !Array.isArray(event.message?.content)) continue;
    const calls = event.message.content.filter((c: { type?: string; name?: string }) => c.type === 'tool_use' && typeof c.name === 'string');
    if (calls.length) rounds.add(event.message.id || `event-${index}`);
    for (const call of calls) result.requestedTools.push(call.name);
  }
  result.toolRounds = rounds.size;
  return result;
}
export function parseClaudeOutput(stdout: string): Envelope {
  // --verbose stream-json exposes actual tool calls for capability evidence.
  let result: Envelope | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as Envelope & { type?: string };
      if (event.type === 'result' || (!event.type && typeof event.is_error === 'boolean')) result = event;
    } catch { /* diagnostic lines are not execution results */ }
  }
  if (!result) throw new Error('Claude 未产生最终执行结果');
  if (typeof result.is_error !== 'boolean' || typeof result.session_id !== 'string' || !result.session_id || !Number.isInteger(result.num_turns) || result.num_turns < 0 || typeof result.total_cost_usd !== 'number' || !Number.isFinite(result.total_cost_usd) || result.total_cost_usd < 0) throw new Error('Claude 最终执行结果缺少有效的会话、轮数或费用字段');
  return result;
}
async function execute(opts: TextRunOpts & { schema?: object; mcpConfigFile?: string }): Promise<RunOutcome> {
  if (opts.claudeRolePolicy) {
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(await cliVersion('claude'));
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && (Number(version[2]) < 1 || (Number(version[2]) === 1 && Number(version[3]) < 295)))) throw new Error('Claude implement 原生角色门禁需要 Claude Code >= 2.1.295（支持 onFailure:block）');
  }
  const env = credentialEnvironment(opts.credentialRef);
  const schemaFile = opts.schema ? path.join(os.tmpdir(), `pipeline-schema-${randomUUID()}.json`).replace(/\\/g, '/') : undefined;
  const roleSettings = opts.claudeRolePolicy ? claudeRoleSettings() : undefined;
  try {
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(opts.schema), { encoding: 'utf8', mode: 0o600 });
    const argv = ['claude', '-p', '--output-format', 'stream-json', '--verbose',
      '--settings', roleSettings ?? RUNNER_SETTINGS, '--permission-mode', 'dontAsk',
      ...(opts.settingSources !== undefined ? ['--setting-sources', opts.settingSources] : []),
      '--allowedTools', opts.tools, '--tools', opts.tools.split(',').filter(t => !t.startsWith('mcp__')).join(','),
      '--model', opts.model, '--effort', opts.effort ?? STAGE_EFFORT,
      '--max-turns', String(opts.maxTurns), '--max-budget-usd', String(opts.budgetUsd),
      '--strict-mcp-config', '--mcp-config', opts.mcpConfigFile ?? '{"mcpServers":{}}',
      ...(opts.pluginDir ? ['--plugin-dir', opts.pluginDir] : []),
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : [])];
    const cmd = argv.map(shq).join(' ') + (schemaFile ? ' --json-schema "$(cat ' + shq(schemaFile) + ')"' : '');
    const result = await runProcess('bash', ['-c', cmd], { cwd: opts.cwd, stdin: opts.prompt, timeoutMs: opts.timeoutMs ?? 3 * 60 * 60 * 1000, env });
    if (result.code !== 0) {
      let envelope: Envelope | undefined;
      try { envelope = parseClaudeOutput(result.stdout); } catch { /* no valid reported usage */ }
      if (!envelope) throw new Error(`Claude 执行失败（exit ${result.code}）：${result.stderr.slice(-400)}`);
      return { envelope: { ...envelope, is_error: true, structured_output: undefined, result: envelope.result || `Claude 执行失败（exit ${result.code}）` }, rawStdout: result.stdout };
    }
    return { envelope: parseClaudeOutput(result.stdout), rawStdout: result.stdout };
  } finally {
    if (schemaFile && fs.existsSync(schemaFile)) fs.unlinkSync(schemaFile);
    if (roleSettings && fs.existsSync(roleSettings)) fs.unlinkSync(roleSettings);
  }
}
export function runClaudeJson(opts: ClaudeJsonOpts): Promise<RunOutcome> { return execute(opts); }
export async function runClaudeText(opts: TextRunOpts): Promise<{
  text: string; costUsd: number; turns: number; isError: boolean; sessionId?: string; rawStdout?: string;
}> {
  const { envelope, rawStdout } = await execute(opts);
  return { text: envelope.result ?? '', costUsd: envelope.total_cost_usd ?? 0,
    turns: envelope.num_turns ?? 0, isError: envelope.is_error === true, sessionId: envelope.session_id, rawStdout };
}
export async function runStage(repo: string, ticket: string, stage: Exclude<Stage, 'ci'>, extraArgs = '', modelOverride?: string): Promise<RunOutcome> {
  const cfg = STAGES[stage];
  const e2e = e2eEnabledFor(repo, stage);
  const mcpConfigFile = e2e ? writeClaudeMcpConfig() : undefined;
  try {
    return await runClaudeJson({ cwd: repo, prompt: `/pipeline-${stage} ${ticket}${extraArgs ? ' ' + extraArgs : ''}`,
      pluginDir: PLUGIN_DIR, tools: e2e ? `${cfg.tools},mcp__playwright` : cfg.tools,
      model: modelOverride ?? cfg.model, maxTurns: cfg.maxTurns, budgetUsd: cfg.budgetUsd,
      schema: JSON.parse(wireSchema(stage)) as object, mcpConfigFile });
  } finally { if (mcpConfigFile && fs.existsSync(mcpConfigFile)) fs.unlinkSync(mcpConfigFile); }
}
