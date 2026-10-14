import type { Engine, TextResult } from './types.js';
import type { ClaudeJsonOpts, RunOutcome, TextRunOpts } from '../runner.js';
import { runProcess, type ProcessResult } from './process.js';
import { CliExecutionError } from './errors.js';
import { PLAYWRIGHT_MCP } from './e2e.js';
import { PLUGIN_DIR, STAGES } from '../config.js';
import { wireSchema } from '../schema.js';
import { sharedPrompt } from './prompt.js';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_OPENCODE_MODEL } from './configuration.js';

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: { type?: string; text?: string; messageID?: string; cost?: number; reason?: string; error?: { message?: string }; state?: { status?: string; error?: string }; };
  error?: { message?: string };
}
export interface OpenCodeSummary { text: string; sessionId?: string; turns: number; costUsd: number; costKnown: boolean; error?: string; complete: boolean; toolErrors?: string[]; }
const INCOMPLETE = 'OpenCode 缺少会话 ID、最终正文或正常完成事件';
/** Malformed or partial streams are errors, never a successful empty reply. */
export function summarizeOpenCode(jsonl: string, native = false): OpenCodeSummary {
  const s: OpenCodeSummary = { text: '', turns: 0, costUsd: 0, costKnown: false, complete: false };
  const messages = new Map<string, { text: string; complete: boolean }>();
  let missingCost = false;
  for (const line of jsonl.split(/\r?\n/).filter(l => l.trim())) {
    let event: OpenCodeEvent;
    try { event = JSON.parse(line); } catch { s.error = 'OpenCode JSON 事件流损坏'; continue; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') { s.error = 'OpenCode JSON 事件字段不合法'; continue; }
    if (event.sessionID) {
      if (s.sessionId && s.sessionId !== event.sessionID) { s.error = 'OpenCode 事件流包含不同会话'; continue; }
      s.sessionId = event.sessionID;
    }
    if (['text', 'step_finish'].includes(event.type) && (!event.part || typeof event.part.messageID !== 'string' || !event.part.messageID)) { s.error = 'OpenCode 消息缺少 messageID'; continue; }
    const messageId = event.part?.messageID ?? 'unknown';
    if (event.type === 'text') {
      const message = messages.get(messageId) ?? { text: '', complete: false };
      if (typeof event.part?.text !== 'string') { s.error = 'OpenCode 正文事件不合法'; continue; }
      message.text += event.part.text;
      messages.set(messageId, message);
    }
    if (event.type === 'tool_use' && event.part?.state?.status === 'error') {
      const error = event.part.state.error || 'OpenCode 工具执行失败';
      (s.toolErrors ??= []).push(error);
      if (!native) s.error = error;
    }
    if (event.type === 'error') s.error = event.error?.message ?? event.part?.error?.message ?? 'OpenCode error';
    if (event.type === 'step_finish') {
      s.turns++;
      if (typeof event.part?.cost === 'number' && Number.isFinite(event.part.cost) && event.part.cost >= 0) { s.costUsd += event.part.cost; }
      else { missingCost = true; if (event.part?.cost !== undefined) s.error = 'OpenCode 费用事件不合法'; }
      const message = messages.get(messageId) ?? { text: '', complete: false };
      message.complete = ['stop', 'end_turn'].includes(event.part?.reason ?? '');
      messages.set(messageId, message);
    }
  }
  const final = [...messages.values()].at(-1);
  s.text = final?.text ?? '';
  s.complete = final?.complete ?? false;
  s.costKnown = s.turns > 0 && !missingCost;
  if (!s.sessionId || !s.text.trim() || !s.complete) s.error ??= INCOMPLETE;
  return s;
}
/** V2.0.6 CLI reconciliation can emit text without step_finish. Require persisted
 * completion for the same message, exact text and a successful idle boundary. */
export function completeOpenCodeFromExport(jsonl: string, value: unknown, native = false): OpenCodeSummary {
  const summary = summarizeOpenCode(jsonl, native);
  if (summary.error !== INCOMPLETE || !summary.sessionId || !summary.text.trim()) return summary;
  const ids = new Set<string>(); let finalId: string | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (typeof e.part?.messageID === 'string') { ids.add(e.part.messageID); finalId = e.part.messageID; } } catch { return summary; }
  }
  const data = value as { info?: { id?: string }; messages?: { id: string; type: string; finish?: string; error?: unknown; cost?: number; outcome?: string; time?: { completed?: number; created?: number }; content?: { type: string; text?: string; state?: { status?: string } }[] }[] };
  if (!data || data.info?.id !== summary.sessionId || !Array.isArray(data.messages) || !data.messages.every(m => m && typeof m.id === 'string' && typeof m.type === 'string' && (m.content === undefined || Array.isArray(m.content)))) return summary;
  const index = data.messages.findIndex(m => m.id === finalId && m.type === 'assistant');
  const final = data.messages[index];
  const idle = data.messages.at(-1);
  const text = final?.content?.filter(c => c.type === 'text').map(c => c.text || '').join('');
  if (!final || final.error || !Number.isFinite(final.time?.completed) || !['stop', 'end_turn'].includes(final.finish || '') || text !== summary.text || idle?.type !== 'idle' || idle.outcome !== 'succeeded' || !Number.isFinite(idle.time?.created) || idle.time!.created! < final.time!.completed! || data.messages.slice(index + 1).some(m => m.type !== 'idle')) return summary;
  const messages = data.messages.filter(m => m.type === 'assistant' && ids.has(m.id));
  if (messages.some(m => m.error || !Number.isFinite(m.time?.completed) || (!native && m.content?.some(c => c.type === 'tool' && c.state?.status === 'error')))) return summary;
  summary.complete = true; summary.error = undefined; summary.turns = messages.length;
  summary.costKnown = messages.length > 0 && messages.every(m => typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost >= 0);
  summary.costUsd = messages.reduce((sum, m) => sum + (typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost >= 0 ? m.cost : 0), 0);
  return summary;
}
export function openCodeConfiguration(tools: string, maxTurns: number, browser = false, executor = 'pipeline-executor', worker = 'pipeline-worker', independentChildProbe = false): object {
  const names = new Set(tools.split(','));
  const mapping: Record<string, string> = { Read: 'read', Grep: 'grep', Glob: 'glob', Write: 'edit', Edit: 'edit', Bash: 'shell', Skill: 'skill', WebFetch: 'webfetch', WebSearch: 'websearch', TodoWrite: 'todo' };
  const permissions = [{ action: '*', resource: '*', effect: 'deny' }];
  for (const action of new Set([...names].map(t => mapping[t]).filter(Boolean))) permissions.push({ action, resource: '*', effect: 'allow' });
  // Only our explicitly defined child can run; global agents keep no authority.
  if (names.has('Agent') || names.has('Task')) permissions.push({ action: 'subagent', resource: worker, effect: 'allow' });
  permissions.push({ action: 'external_directory', resource: `${PLUGIN_DIR.replace(/\\/g, '/')}/*`, effect: 'allow' });
  if (browser) permissions.push({ action: 'playwright_*', resource: '*', effect: 'allow' });
  const childPermissions = permissions.filter(p => p.action !== 'subagent');
  const parentPermissions = independentChildProbe ? [...permissions, { action: 'read', resource: '*', effect: 'deny' }] : permissions;
  return { skills: [`${PLUGIN_DIR.replace(/\\/g, '/')}/skills`], agents: {
    [executor]: { mode: 'primary', description: 'Pipeline execution with explicit constraints', system: 'Follow the pipeline instructions and the user output contract exactly. When JSON is requested, your final response must contain only that JSON object, with no Markdown, fences, preamble or explanation. Use only permitted tools. Report missing required capabilities explicitly.', steps: maxTurns, permissions: parentPermissions },
    [worker]: { mode: 'subagent', description: 'Independent pipeline task with explicitly copied permissions and its own step limit',
      system: 'You are an independent pipeline worker. Execute the specific assigned task with the permitted tools, following the shared project rules and any assigned skill. Read requested files using the read tool; return their actual contents when asked. Do not explore unrelated files, guess session IDs, fabricate results, or finish with only an acknowledgement. Return the concrete task result or a precise error.',
      steps: maxTurns, permissions: childPermissions },
  }, ...(browser ? { mcp: { servers: { playwright: { type: 'local', command: [PLAYWRIGHT_MCP.command, ...PLAYWRIGHT_MCP.args] } } } } : {}) };
}
export async function verifiedOpenCodeResult(processResult: ProcessResult, options: { command: string; cwd: string; env: NodeJS.ProcessEnv; native?: boolean }): Promise<OpenCodeSummary> {
  let summary = summarizeOpenCode(processResult.stdout, options.native);
  if (processResult.code === 0 && summary.error === INCOMPLETE && summary.sessionId && summary.text.trim()) {
    // Sanitization replaces all text, preventing exact-message verification. Keep the
    // authorized session export in memory only; never log or persist its history.
    const exported = await runProcess(options.command, ['session', 'export', summary.sessionId, '--standalone'], { cwd: options.cwd, env: options.env, timeoutMs: 15000 });
    if (exported.code === 0) { try { summary = completeOpenCodeFromExport(processResult.stdout, JSON.parse(exported.stdout), options.native); } catch { /* invalid metadata cannot authorize completion */ } }
  }
  if (processResult.code !== 0 || summary.error) throw new CliExecutionError(`OpenCode 执行失败：${summary.error || processResult.stderr.slice(-400) || `exit ${processResult.code}`}`, {
    is_error: true, session_id: summary.sessionId || '', num_turns: summary.turns, total_cost_usd: summary.costUsd,
    costStatus: summary.costUsd > 0 ? 'partial' : 'unknown', permission_denials: [],
  });
  return summary;
}
async function execute(opts: TextRunOpts, structuredSchema?: unknown): Promise<{ summary: OpenCodeSummary; stdout: string }> {
  if (opts.credentialRef) throw new Error('OpenCode 凭据由原生配置管理，不支持 credentialRef');
  // No weaker best-effort budget monitor: this is checked before any model request.
  if (opts.constraintMode !== 'native' && opts.budgetUsd > 0) throw new Error('OpenCode 当前不支持必需的金额预算硬限制，已阻止调用模型');
  const identity = createHash('sha256').update(JSON.stringify([opts.model, opts.tools, opts.maxTurns, opts.budgetUsd, opts.cwd])).digest('hex').slice(0, 16);
  const executor = `pipeline-${identity}-executor`, worker = `pipeline-${identity}-worker`;
  const inherited = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  if (!inherited || typeof inherited !== 'object' || Array.isArray(inherited)) throw new Error('OPENCODE_CONFIG_CONTENT 必须为配置对象');
  const pinned = openCodeConfiguration(opts.tools, opts.maxTurns, opts.tools.includes('mcp__playwright'), executor, worker, opts.independentChildProbe) as { agents: Record<string, { system: string }>; skills: string[]; mcp?: { servers: object } };
  // Agent instructions survive native compaction; the initial user message may not.
  if (structuredSchema !== undefined) pinned.agents[executor].system += `\nReturn the task's actual result as a single JSON object. The following is a SCHEMA describing the result, not the result itself. Never echo schema keywords such as properties or required as your answer. Populate the required result fields using the requested or observed values. Result schema: ${JSON.stringify(structuredSchema)}`;
  const content = { ...inherited, ...pinned, agents: { ...inherited.agents, ...pinned.agents }, skills: [...(inherited.skills || []), ...pinned.skills],
    mcp: { ...inherited.mcp, servers: { ...inherited.mcp?.servers, ...pinned.mcp?.servers } } };
  const env = { ...process.env, PWD: opts.cwd, OPENCODE_CONFIG_CONTENT: JSON.stringify(content) };
  const args = ['run', '--standalone', '--format', 'json', '--agent', executor,
    ...(opts.model && opts.model !== '@cli-default' ? ['--model', opts.model] : []),
    ...(opts.resumeSessionId ? ['--session', opts.resumeSessionId] : [])];
  const prompt = opts.tools.split(',').some(t => t === 'Agent' || t === 'Task') ? `${opts.prompt}\n如果本次任务要求独立子代理，唯一获准的原生子代理 ID 是 ${worker}；调用 subagent 时将 agent 参数设为这个完整 ID，并等待真实结果，不要使用未配置的代理或猜测会话 ID。仅返回 JSON 等不要求子代理的任务无需派发。` : opts.prompt;
  const result = await runProcess(process.env.PIPELINE_OPENCODE_BIN || 'opencode', args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 3 * 60 * 60 * 1000, env, stdin: prompt });
  return { summary: await verifiedOpenCodeResult(result, { command: process.env.PIPELINE_OPENCODE_BIN || 'opencode', cwd: opts.cwd, env, native: opts.constraintMode === 'native' }), stdout: result.stdout };
}
export const opencodeEngine: Engine = {
  name: 'opencode',
  async runText(opts): Promise<TextResult> {
    const { summary, stdout } = await execute(opts);
    return { text: summary.text, sessionId: summary.sessionId, turns: summary.turns, costUsd: summary.costUsd, isError: false, costStatus: summary.costKnown && summary.costUsd > 0 ? 'reported' : 'unknown', rawStdout: stdout };
  },
  async runJson(opts: ClaudeJsonOpts): Promise<RunOutcome> {
    const started = Date.now();
    let { summary, stdout } = await execute({ ...opts, prompt: `${opts.prompt}\n\n最终仅返回满足以下 JSON Schema 的 JSON 对象：\n${JSON.stringify(opts.schema)}` }, opts.schema);
    let structured_output;
    let outputCorrection: import('../types.js').Envelope['outputCorrection'];
    let overlongResult: Record<string, unknown> | undefined;
    const fence = opts.constraintMode === 'native' ? /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(summary.text.trim()) : null;
    try {
      structured_output = JSON.parse(fence ? fence[1] : summary.text);
      const limit = (opts.schema as { properties?: { summary_for_card?: { maxLength?: number } } })?.properties?.summary_for_card?.maxLength;
      if (opts.constraintMode === 'native' && typeof limit === 'number' && typeof structured_output?.summary_for_card === 'string' && Array.from(structured_output.summary_for_card).length > limit) {
        const validate = new Ajv().compile(opts.schema);
        if (!validate(structured_output) && validate.errors?.every(e => e.keyword === 'maxLength' && e.instancePath === '/summary_for_card')) {
          overlongResult = structured_output;
          throw new Error('Card summary length needs output correction');
        }
      }
    }
    catch {
      const original = summary;
      const failure = (reason: string) => new CliExecutionError(reason, { is_error: true, session_id: original.sessionId!, num_turns: summary.turns, total_cost_usd: summary.costUsd, costStatus: summary.costKnown && summary.costUsd > 0 ? 'reported' : 'unknown', permission_denials: [], outputCorrection });
      const remaining = (opts.timeoutMs ?? 3 * 60 * 60 * 1000) - (Date.now() - started);
      if (opts.constraintMode !== 'native' || remaining <= 0) throw failure('OpenCode 最终回复不是 JSON 对象');
      // One visible native continuation, never extraction from a prose answer.
      // Its empty permission set cannot re-execute the task or create role proof.
      let correction;
      outputCorrection = { attempts: 1, sessionId: original.sessionId!, initialTurns: original.turns, correctionTurns: 0 };
      try {
        correction = await execute({ ...opts, tools: '', maxTurns: 1, timeoutMs: remaining, resumeSessionId: summary.sessionId,
          prompt: `Output format correction only. ${overlongResult ? 'Your preceding JSON exceeded summary_for_card maxLength. Shorten only summary_for_card to the schema limit; preserve every other field and value exactly.' : 'Your preceding completed reply failed JSON parsing. Re-send that same actual task result as one JSON object matching the schema.'} Do not execute the task again, change its outcome, use tools, or invent evidence. Your entire final response must be the JSON object: no explanation or Markdown fences. Schema: ${JSON.stringify(opts.schema)}` }, opts.schema);
      } catch (error) {
        if (error instanceof CliExecutionError) throw new CliExecutionError(error.message, { ...error.envelope, session_id: summary.sessionId!, num_turns: summary.turns + error.envelope.num_turns, total_cost_usd: summary.costUsd + error.envelope.total_cost_usd, costStatus: 'partial', outputCorrection: { ...outputCorrection, correctionTurns: error.envelope.num_turns } });
        throw new CliExecutionError('OpenCode 原会话格式修正调用失败（追加用量未知）', { ...failure('').envelope, costStatus: 'partial' });
      }
      try {
        stdout += `\n${correction.stdout}`;
        const originalId = summary.sessionId;
        summary = { ...correction.summary, turns: summary.turns + correction.summary.turns, costUsd: summary.costUsd + correction.summary.costUsd, costKnown: summary.costKnown && correction.summary.costKnown };
        outputCorrection.correctionTurns = correction.summary.turns;
        if (summary.sessionId !== originalId) throw failure('OpenCode 格式修正未沿用原生会话');
        if (correction.stdout.split(/\r?\n/).filter(Boolean).some(line => JSON.parse(line).type === 'tool_use')) throw failure('OpenCode 格式修正调用了任务工具');
        structured_output = JSON.parse(summary.text);
        if (!new Ajv().compile(opts.schema)(structured_output)) throw failure('OpenCode 格式修正不满足原 JSON 契约');
        if (overlongResult) {
          const { summary_for_card: _before, ...before } = overlongResult;
          const { summary_for_card: _after, ...after } = structured_output as Record<string, unknown>;
          if (!isDeepStrictEqual(before, after)) throw failure('OpenCode 摘要长度修正改变了其他结果字段');
        }
      } catch (error) {
        if (error instanceof CliExecutionError) throw error;
        throw failure('OpenCode 最终回复不是 JSON 对象（原会话格式修正仍失败）');
      }
    }
    return { envelope: { is_error: false, session_id: summary.sessionId!, num_turns: summary.turns, total_cost_usd: summary.costUsd, costStatus: summary.costKnown && summary.costUsd > 0 ? 'reported' : 'unknown', permission_denials: [], structured_output, result: summary.text, ...(outputCorrection ? { outputCorrection } : {}) }, rawStdout: stdout };
  },
  async runStage(repo, ticket, stage, extraArgs = '') {
    const cfg = STAGES[stage];
    return opencodeEngine.runJson({ cwd: repo, prompt: sharedPrompt(`/pipeline-${stage} ${ticket} ${extraArgs}`, repo, PLUGIN_DIR, true), pluginDir: PLUGIN_DIR,
      model: process.env.PIPELINE_OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL, tools: cfg.tools, maxTurns: cfg.maxTurns, budgetUsd: cfg.budgetUsd, schema: JSON.parse(wireSchema(stage)) });
  },
};
