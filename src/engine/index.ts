import { Ajv } from 'ajv';
import fs from 'node:fs';
import { claudeEngine } from './claude.js';
import { codexEngine } from './codex.js';
import { opencodeEngine } from './opencode.js';
import type { Engine } from './types.js';
import { assertExecutable, freezeExecution, knownCli, executionConstraints, DEFAULT_CLI, type Entry, type ExecutionSnapshot } from './configuration.js';
import type { ClaudeJsonOpts, TextRunOpts } from '../runner.js';
import { credentialEnvironment } from '../runner.js';
import { sharedPrompt } from './prompt.js';
import { PLUGIN_DIR } from '../config.js';
import { writeClaudeMcpConfig } from './e2e.js';
import { wireSchema } from '../schema.js';
import { assertRuntimeIdentity } from './identity.js';
import { CliExecutionError } from './errors.js';
import { beginRoleAudit } from './claudeRoles.js';
import { observedNativeModel } from './nativeDefaults.js';

export type { Engine, TextResult } from './types.js';

const REGISTRY: Record<string, Engine> = { claude: claudeEngine, codex: codexEngine, opencode: opencodeEngine };

export function engineNamed(name: string | null | undefined): Engine {
  return REGISTRY[knownCli(name ?? DEFAULT_CLI)];
}

/**
 * Resolve once for a new entry, or use the ticket/session snapshot without re-reading defaults.
 */
export function engineFor(repo: string | undefined, entry: Entry = 'run', frozen?: ExecutionSnapshot): Engine {
  const snapshot = frozen ?? freezeExecution(repo, entry);
  if (snapshot.entry !== entry) throw new Error(`执行快照入口不一致：${snapshot.entry} / ${entry}`);
  const native = engineNamed(snapshot.profile.cli);
  const prepare = (opts: TextRunOpts): TextRunOpts => {
    assertExecutable(snapshot);
    if (snapshot.profile.cli === 'claude' && snapshot.profile.credentialRef) credentialEnvironment(snapshot.profile.credentialRef);
    return { ...opts, prompt: sharedPrompt(opts.prompt, opts.cwd, opts.pluginDir), model: snapshot.model,
      tools: snapshot.tools + (snapshot.browser ? ',mcp__playwright' : ''), maxTurns: snapshot.maxTurns,
      budgetUsd: snapshot.budgetUsd, timeoutMs: snapshot.timeoutMs,
      effort: snapshot.profile.parameters.effort, credentialRef: snapshot.profile.credentialRef, settingSources: undefined,
      constraintMode: snapshot.constraintMode ?? 'strict', windowsSandbox: snapshot.profile.parameters.windowsSandbox,
      claudeRolePolicy: snapshot.profile.cli === 'claude' && entry === 'implement', independentChildProbe: undefined };
  };
  const runJson = async (opts: ClaudeJsonOpts) => {
    const prepared = prepare(opts) as ClaudeJsonOpts;
    await assertRuntimeIdentity(snapshot.profile, opts.cwd, snapshot.nativeContext);
    const ticket = /^\/pipeline-implement\s+([\w.-]+)/.exec(opts.prompt)?.[1];
    if (prepared.claudeRolePolicy && !ticket) throw new Error('Claude implement 入口需要真实工单参数以核验独立子代理角色');
    const audit = prepared.claudeRolePolicy && ticket ? beginRoleAudit(opts.cwd, ticket) : undefined;
    prepared.prompt = sharedPrompt(opts.prompt, opts.cwd, opts.pluginDir, true);
    if (snapshot.constraintMode === 'native') prepared.prompt += `\n原生约束已获用户接受：${JSON.stringify(executionConstraints(snapshot))}。Claude 别名不适用于其他 CLI；使用当前 CLI 原生子代理及模型配置，仍必须独立实现、独立评审，不得模拟子代理。`;
    const mcp = snapshot.browser && snapshot.profile.cli === 'claude' ? writeClaudeMcpConfig() : undefined;
    try {
      const result = await native.runJson({ ...prepared, mcpConfigFile: mcp });
      if (audit) {
        try { audit(result.rawStdout, result.envelope.session_id, !result.envelope.is_error && ['DONE', 'DONE_WITH_CONCERNS'].includes(result.envelope.structured_output?.status || '')); }
        catch (e) { throw new CliExecutionError(`Claude implement 子代理角色核验失败：${(e as Error).message}`, { ...result.envelope, is_error: true, structured_output: undefined }); }
      }
      if (result.envelope.is_error) throw new CliExecutionError(result.envelope.result || 'CLI 执行失败', result.envelope);
      const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(opts.schema);
      if (!validate(result.envelope.structured_output)) throw new CliExecutionError(`CLI 结构化返回不符合契约：${JSON.stringify(validate.errors)}`, { ...result.envelope, is_error: true, structured_output: undefined });
      return { ...result, envelope: { ...result.envelope, observedModel: observedNativeModel(native.name, result.rawStdout) }, execution: snapshot };
    } finally { if (mcp && fs.existsSync(mcp)) fs.unlinkSync(mcp); }
  };
  return { name: native.name, execution: snapshot, runJson,
    async runText(opts) {
      const prepared = prepare(opts);
      await assertRuntimeIdentity(snapshot.profile, opts.cwd, snapshot.nativeContext);
      const result = await native.runText(prepared);
      if (result.isError) throw new CliExecutionError(result.text || 'CLI 执行失败', { is_error: true, result: result.text, num_turns: result.turns, total_cost_usd: result.costUsd, costStatus: result.costStatus === 'unknown' ? 'unknown' : 'reported', session_id: result.sessionId || '', permission_denials: [] });
      if (opts.resumeSessionId && result.sessionId !== opts.resumeSessionId) throw new Error('CLI 未恢复原会话，拒绝将新会话当作续聊');
      return { ...result, observedModel: observedNativeModel(native.name, result.rawStdout), execution: snapshot };
    },
    async runStage(cwd, ticket, stage, extraArgs = '') {
      return runJson({ cwd, prompt: `/pipeline-${stage} ${ticket}${extraArgs ? ' ' + extraArgs : ''}`, pluginDir: PLUGIN_DIR,
        schema: JSON.parse(wireSchema(stage)), tools: snapshot.tools, model: snapshot.model, maxTurns: snapshot.maxTurns, budgetUsd: snapshot.budgetUsd });
    } };
}
