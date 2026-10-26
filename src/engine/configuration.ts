import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';
import { STAGES, resolveImplementModel } from '../config.js';
import { readProfile } from '../profile.js';
import os from 'node:os';
import { profileCredentialContext, type IdentityPolicy } from './identity.js';
import { withFileLock } from './fileLock.js';

export const ENTRIES = ['clarify', 'plan', 'implement', 'review', 'acceptance', 'compound', 'triage', 'fast', 'classify', 'run', 'draft', 'prototype', 'mr-review'] as const;
export type Entry = typeof ENTRIES[number];
export type Cli = 'claude' | 'codex' | 'opencode';
export const DEFAULT_CLI: Cli = 'codex';
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
// Built-in OpenCode provider; freeze an explicit ID to avoid native paid fallback.
export const DEFAULT_OPENCODE_MODEL = 'opencode/space-bunny-free';
export class ExecutionConfigError extends Error { readonly code = 'EXECUTION_CONFIG'; }
export type WindowsSandbox = 'elevated' | 'unelevated' | 'mxc';
export interface Parameters { maxTurns?: number; budgetUsd?: number; timeoutMs?: number; effort?: 'low' | 'medium' | 'high' | 'max'; windowsSandbox?: WindowsSandbox; }
export interface AgentProfile {
  id: string;
  name: string;
  cli: Cli;
  constraintMode?: 'native' | 'strict';
  model?: string;
  /** cli freezes the choice to follow native defaults, not a particular model. */
  modelSource?: 'cli';
  provider?: string;
  credentialRef?: string;
  parameters: Parameters;
  state: 'draft' | 'active' | 'legacy';
  validation?: { fingerprint: string; at: string; entries: Entry[]; cliVersion: string; account: string; checks: string[]; command?: string; credentialContext?: string; identityPolicy?: IdentityPolicy; resolved?: Partial<Record<Entry, string>> };
}
export interface Selection { default?: string; entries?: Partial<Record<Entry, string>>; }
export interface Configuration {
  version: 1;
  revision: number;
  profiles: AgentProfile[];
  global: Selection;
  projects: Record<string, Selection>;
}
export interface ExecutionSnapshot {
  version: 1;
  createdAt: string;
  entry: Entry;
  profile: AgentProfile;
  model: string;
  modelSource?: 'cli';
  tools: string;
  maxTurns: number;
  budgetUsd: number;
  timeoutMs: number;
  browser: boolean;
  /** Missing on historical snapshots means the original strict contract. */
  constraintMode?: 'native' | 'strict';
  nativeContext?: string;
}
export type ExecutionPlan = Record<Entry, ExecutionSnapshot>;
export function executionModelRecord(snapshot?: ExecutionSnapshot, observedModel?: string): { model?: string; modelSource?: 'cli' } {
  return snapshot?.profile.modelSource === 'cli' ? { modelSource: 'cli', model: observedModel } : { model: observedModel ?? snapshot?.model };
}
export interface PendingSwitch { plan: ExecutionPlan; by: string; reason: string; requestedAt: string; afterStage: string; requestId?: string; }

export const configurationFile = (): string => process.env.PIPELINE_AGENT_CONFIG_FILE || path.join(dataDir(), 'agent-config.json');
const cliNames: Cli[] = ['claude', 'codex', 'opencode'];
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const fail = (message: string): never => { throw new ExecutionConfigError(message); };
export function knownCli(name: string): Cli {
  const key = name.trim().toLowerCase() as Cli;
  return cliNames.includes(key) ? key : fail(`未知 agent CLI「${name}」，可选 claude / codex / opencode`);
}
export function profileFingerprint(profile: AgentProfile): string {
  const { state: _state, validation: _validation, ...body } = profile;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export function initialConfiguration(): Configuration {
  return { version: 1, revision: 0, profiles: cliNames.map(cli => ({ id: `legacy-${cli}`, name: `${cli}（原配置）`, cli, parameters: {}, state: 'legacy' })), global: { default: `legacy-${DEFAULT_CLI}` }, projects: {} };
}
export function validateConfiguration(value: unknown): Configuration {
  const c = value as Configuration;
  if (!c || c.version !== 1 || !Number.isInteger(c.revision) || c.revision < 0 || !Array.isArray(c.profiles) || !c.global || !c.projects || Array.isArray(c.projects)) fail('执行配置文件格式不合法');
  const ids = new Set<string>();
  for (const p of c.profiles) {
    if (!p || !idPattern.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !cliNames.includes(p.cli) || !p.parameters || Array.isArray(p.parameters)) fail('执行配置名称、ID 或 CLI 不合法');
    ids.add(p.id);
    if (!['draft', 'active', 'legacy'].includes(p.state)) fail(`配置 ${p.id} 状态不合法`);
    if (p.state === 'legacy' && (!/^legacy-(claude|codex|opencode)$/.test(p.id) || p.id !== `legacy-${p.cli}` || Object.keys(p.parameters).length || p.model || p.modelSource || p.provider || p.credentialRef)) fail('legacy 仅用于未修改的原有 CLI 配置');
    for (const key of Object.keys(p)) if (!['id', 'name', 'cli', 'constraintMode', 'model', 'modelSource', 'provider', 'credentialRef', 'parameters', 'state', 'validation'].includes(key)) fail(`不支持的执行配置字段 ${key}（密钥由 CLI 管理）`);
    if (p.modelSource !== undefined && p.modelSource !== 'cli') fail('模型来源不合法');
    if (p.modelSource === 'cli' && ((p.constraintMode ?? 'native') !== 'native' || p.model || p.parameters.effort || p.provider || p.credentialRef)) fail('跟随 CLI 时使用原生约束，模型、推理强度、提供商及认证均由 CLI 配置');
    if (p.constraintMode !== undefined && !['native', 'strict'].includes(p.constraintMode)) fail('约束模式必须为 native 或 strict');
    for (const key of ['model', 'provider', 'credentialRef'] as const) if (p[key] !== undefined && (typeof p[key] !== 'string' || !p[key]!.trim() || /[\r\n\0]/.test(p[key]!))) fail(`${p.id}: ${key} 不合法`);
    if (p.credentialRef && !/^[A-Z][A-Z0-9_]*$/.test(p.credentialRef)) fail('凭据引用必须是环境变量名，不能填写密钥');
    if (p.cli !== 'claude' && p.credentialRef) fail(`${p.cli} 凭据由原生配置管理，不支持 credentialRef`);
    for (const [k, v] of Object.entries(p.parameters)) {
      if (!['maxTurns', 'budgetUsd', 'timeoutMs', 'effort', 'windowsSandbox'].includes(k)) fail(`不支持的运行参数 ${k}`);
      if (k === 'windowsSandbox') { if (p.cli !== 'codex' || !['elevated', 'unelevated', 'mxc'].includes(String(v))) fail('windowsSandbox 仅支持 Codex 的 elevated / unelevated / mxc'); continue; }
      if (k === 'effort') { if (!['low', 'medium', 'high', 'max'].includes(String(v))) fail('effort 不合法'); }
      else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (k !== 'budgetUsd' && !Number.isInteger(v))) fail(`${k} 必须为正${k === 'budgetUsd' ? '数' : '整数'}`);
    }
    if (p.cli !== 'opencode' && p.provider && p.provider !== 'cli') fail(`${p.cli} 提供商由其原生配置管理，请使用 provider=cli`);
    if (p.state === 'active' && (!p.validation || p.validation.fingerprint !== profileFingerprint(p) || !Array.isArray(p.validation.entries))) fail(`${p.id} 缺少匹配当前内容的能力验证`);
    if (p.state === 'active' && p.modelSource === 'cli' && p.validation?.identityPolicy !== 'cli-defaults-v1') fail(`${p.id} 缺少跟随 CLI 策略的能力验证`);
  }
  const selection = (s: Selection): void => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail('选择规则必须是对象');
    for (const key of Object.keys(s)) if (!['default', 'entries'].includes(key)) fail(`未知选择规则 ${key}`);
    for (const [entry, id] of Object.entries(s.entries ?? {})) if (!ENTRIES.includes(entry as Entry) || !ids.has(id!)) fail(`入口或配置不存在：${entry}=${id}`);
    if (s.default !== undefined && !ids.has(s.default)) fail(`配置不存在：${s.default}`);
    const selected = s.default ? c.profiles.find(p => p.id === s.default) : undefined;
    if (selected?.state === 'active' && ENTRIES.some(entry => !selected.validation!.entries.includes(entry))) fail('默认配置必须验证全部入口；部分用途配置请按入口选择');
    for (const [entry, id] of Object.entries(s.entries ?? {})) {
      const profile = c.profiles.find(p => p.id === id)!;
      if (profile.state === 'active' && !profile.validation!.entries.includes(entry as Entry)) fail(`配置 ${id} 未验证入口 ${entry}`);
    }
  };
  selection(c.global);
  for (const [repo, s] of Object.entries(c.projects)) { if (!path.isAbsolute(repo)) fail('项目覆盖必须使用仓库绝对路径'); selection(s); }
  return c;
}
export function readConfiguration(): Configuration {
  const file = configurationFile();
  if (!fs.existsSync(file)) return initialConfiguration();
  try { return validateConfiguration(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { return fail(`执行配置读取失败：${(e as Error).message}`); }
}
/** Exclusive lock plus revision check protects web/daemon and direct file edits. */
export function writeConfiguration(value: Configuration, expectedRevision: number): Configuration {
  const file = configurationFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  return withFileLock(lock, () => {
    const previous = readConfiguration();
    if (previous.revision !== expectedRevision) fail('执行配置已被修改，请刷新后重试');
    const next = validateConfiguration({ ...value, revision: previous.revision + 1 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return next;
  });
}

function fileSelection(repo: string): Selection {
  const file = path.join(repo, 'docs/pipeline/PIPELINE.md');
  if (!fs.existsSync(file)) return {};
  const md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? '';
  const result: Selection = { entries: {} };
  for (const line of fm.split('\n')) {
    const m = /^\s*execution(?:\.([a-z-]+))?\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const id = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (!id) continue;
    if (m[1]) { if (!ENTRIES.includes(m[1] as Entry)) fail(`未知执行入口 ${m[1]}`); result.entries![m[1] as Entry] = id; }
    else result.default = id;
  }
  return result;
}
export function selectProfile(repo: string | undefined, entry: Entry, configuration = readConfiguration()): AgentProfile {
  const file = repo ? fileSelection(repo) : {};
  const project = repo ? configuration.projects[path.resolve(repo)] ?? {} : {};
  const legacy = repo ? readProfile(repo)?.engine : undefined;
  // Console values win over matching file values, at the same specificity.
  const id = project.entries?.[entry] ?? file.entries?.[entry] ?? (legacy?.byStage[entry] ? `legacy-${knownCli(legacy.byStage[entry])}` : undefined)
    ?? project.default ?? file.default ?? (legacy?.default ? `legacy-${knownCli(legacy.default)}` : undefined)
    ?? configuration.global.entries?.[entry] ?? configuration.global.default ?? `legacy-${DEFAULT_CLI}`;
  const profile = configuration.profiles.find(p => p.id === id);
  if (!profile) return fail(`入口 ${entry} 指向不存在的执行配置 ${id}`);
  if (profile.state === 'draft') return fail(`执行配置「${profile.name}」尚未通过能力验证`);
  if (profile.state === 'active' && !profile.validation?.entries.includes(entry)) return fail(`执行配置「${profile.name}」未验证入口 ${entry}`);
  return structuredClone(profile);
}
export const ENTRY_DEFAULTS: Record<Entry, { model: string; tools: string; maxTurns: number; budgetUsd: number }> = {
  ...STAGES,
  triage: { model: 'haiku', tools: 'Read,Grep,Glob', maxTurns: 8, budgetUsd: 0.5 },
  fast: { model: 'sonnet', tools: 'Read,Grep,Glob,Write,Edit,Bash', maxTurns: 60, budgetUsd: 5 },
  classify: { model: 'sonnet', tools: 'Read', maxTurns: 3, budgetUsd: 0.2 },
  run: { model: 'sonnet', tools: 'Read,Grep,Glob,Bash,Skill,WebFetch', maxTurns: 40, budgetUsd: 3 },
  draft: { model: 'sonnet', tools: 'Read', maxTurns: 3, budgetUsd: 0.5 },
  prototype: { model: 'sonnet', tools: 'Read,Grep,Glob,Write,Edit,Bash', maxTurns: 40, budgetUsd: 3 },
  'mr-review': { model: 'opus', tools: 'Read,Grep,Glob,Bash', maxTurns: 80, budgetUsd: 10 },
};
export function freezeExecution(repo: string | undefined, entry: Entry, profile = selectProfile(repo, entry), executionCwd = repo): ExecutionSnapshot {
  const defaults = ENTRY_DEFAULTS[entry];
  const envModel = entry === 'run' ? process.env.PIPELINE_RUN_MODEL : entry === 'classify' ? process.env.PIPELINE_CLASSIFY_MODEL : entry === 'implement' ? resolveImplementModel().model : undefined;
  const selectedModel = profile.modelSource === 'cli' ? '@cli-default' : profile.model ?? (profile.cli === 'claude' ? envModel || defaults.model : process.env[`PIPELINE_${profile.cli.toUpperCase()}_MODEL`] || (profile.cli === 'codex' ? DEFAULT_CODEX_MODEL : (!profile.provider || profile.provider === 'opencode' ? DEFAULT_OPENCODE_MODEL : '@cli-default')));
  const model = profile.cli === 'opencode' && profile.provider && selectedModel !== '@cli-default' && !selectedModel.startsWith(`${profile.provider}/`) ? `${profile.provider}/${selectedModel}` : selectedModel;
  const params = profile.parameters;
  return { version: 1, createdAt: new Date().toISOString(), entry, profile: structuredClone(profile), model,
    ...(profile.modelSource === 'cli' ? { modelSource: 'cli' as const } : {}),
    tools: defaults.tools, maxTurns: params.maxTurns ?? defaults.maxTurns,
    budgetUsd: params.budgetUsd ?? (entry === 'run' ? Number(process.env.PIPELINE_RUN_BUDGET ?? defaults.budgetUsd) : defaults.budgetUsd),
    timeoutMs: params.timeoutMs ?? 3 * 60 * 60 * 1000,
      browser: !!repo && ['review', 'acceptance', 'mr-review'].includes(entry) && readProfile(repo)?.e2e === 'playwright',
      constraintMode: profile.constraintMode ?? 'native', nativeContext: executionCwd ? profileCredentialContext(profile, executionCwd) : undefined };
}
export function freezePlan(repo: string, configuration = readConfiguration(), executionCwd = repo): ExecutionPlan {
  return Object.fromEntries(ENTRIES.map(entry => [entry, freezeExecution(repo, entry, selectProfile(repo, entry, configuration), executionCwd)])) as ExecutionPlan;
}
export interface Capability { supported: boolean; reason: string; }
export function capabilities(cli: Cli): Record<string, Capability> {
  const yes = (reason: string): Capability => ({ supported: true, reason });
  const no = (reason: string): Capability => ({ supported: false, reason });
  return { text: yes('原生非交互执行'), structured: yes(cli === 'claude' ? '--json-schema' : cli === 'codex' ? '--output-schema' : '最终 JSON + 编排器 AJV 校验'),
    resume: yes('原生会话 ID 续接'), browser: yes('显式 Playwright MCP，需实际探测'),
    permissions: cli === 'claude' ? yes('禁用非白名单工具') : no(cli === 'codex' ? 'Codex sandbox 不能等价执行入口的工具白名单' : 'OpenCode edit 合并写入与编辑，尚未验证等价白名单与继承 MCP 隔离'),
    maxTurns: cli === 'claude' ? yes('--max-turns') : no(cli === 'codex' ? '当前 Codex CLI 没有可执行的模型轮数上限' : 'OpenCode agents.steps 只限制各代理各条消息，尚未验证会话及子代理的总轮数约束'),
    budget: cli === 'claude' ? yes('--max-budget-usd，按已完成模型轮次检查，单轮可能越额') : no('没有原生金额上限；原生模式允许执行，预算设置不执行停机'),
    subagents: cli === 'claude' ? yes('原生 Agent / Task；须探测独立执行和约束') : no('使用原生子代理及角色模型配置；独立执行须真实验证，不宣称 Claude 等价继承') };
}
export function assertRequirements(s: ExecutionSnapshot): void {
  if (!s || s.version !== 1 || !ENTRIES.includes(s.entry) || !s.profile) fail('缺少有效的执行配置快照');
  knownCli(s.profile.cli);
  if (typeof s.model !== 'string' || !s.model.trim() || s.tools !== ENTRY_DEFAULTS[s.entry].tools || typeof s.browser !== 'boolean') fail('执行快照模型或工具集合不合法');
  for (const [name, value] of Object.entries({ maxTurns: s.maxTurns, budgetUsd: s.budgetUsd, timeoutMs: s.timeoutMs })) if (!Number.isFinite(value) || value <= 0 || (name !== 'budgetUsd' && !Number.isInteger(value))) fail(`${name} 必须为正数`);
  const required = ['permissions', 'maxTurns', 'budget', ...(s.entry === 'implement' ? ['subagents'] : []), ...(s.browser ? ['browser'] : [])];
  const caps = capabilities(s.profile.cli);
  if (s.browser && s.profile.state === 'active' && !s.profile.validation?.checks.some(check => check.startsWith('Playwright MCP'))) fail('该配置没有浏览器能力验证证据');
  if (s.constraintMode !== undefined && !['native', 'strict'].includes(s.constraintMode)) fail('执行快照约束模式不合法');
  if (s.nativeContext !== undefined && !/^[a-f0-9]{64}$/.test(s.nativeContext)) fail('原生配置快照指纹不合法');
  const missing = (s.constraintMode === 'native' ? [] : required).filter(k => !caps[k].supported);
  const reasons = missing.map(k => caps[k].reason);
  if (s.model === '@cli-default' && !(s.profile.modelSource === 'cli' && s.constraintMode === 'native')) reasons.push('未冻结明确模型且未明确选择跟随 CLI，不能隐式继承 CLI 默认模型');
  if (s.profile.modelSource === 'cli' && s.model !== '@cli-default') reasons.push('跟随 CLI 的快照不能覆盖原生模型');
  if (s.modelSource !== s.profile.modelSource) reasons.push('模型来源与执行快照不一致');
  if (reasons.length) fail(`${s.profile.name} 无法用于 ${s.entry}：${reasons.join('；')}。未切换其他 CLI。`);
}
/** Describes enforced native limits without representing an unsupported setting as a guard. */
export function executionConstraints(s: ExecutionSnapshot) {
  const cli = s.profile.cli;
  return { mode: s.constraintMode ?? 'strict',
    permissions: cli === 'claude' ? '工具白名单' : cli === 'codex' ? 'read-only / workspace-write 沙箱，非逐工具白名单' : '原生权限动作；Write/Edit/patch 共享 edit 权限',
    turns: { requested: s.maxTurns, enforced: cli !== 'codex', scope: cli === 'claude' ? '主会话工具回合' : cli === 'opencode' ? '各代理每条消息的模型步骤，末步不提供工具' : '无原生轮数上限' },
    budget: { requestedUsd: s.budgetUsd, enforced: cli === 'claude', scope: cli === 'claude' ? '响应完成后检查，可越额；非全树绝对硬上限' : '无原生金额上限，设置值不构成执行限制' },
    timeoutMs: s.timeoutMs,
    windowsSandbox: cli === 'codex' ? s.profile.parameters.windowsSandbox ?? 'CLI 原生配置' : undefined,
    effort: { requested: s.profile.parameters.effort ?? 'CLI 默认', applied: cli !== 'opencode', scope: cli === 'opencode' ? '请用明确 model#variant 选择原生档位；通用 effort 字段不执行' : cli === 'codex' ? (s.profile.parameters.effort ? 'model_reasoning_effort，max 映射为 xhigh' : '随 CLI 当前配置；实际值由 CLI 决定') : '--effort' },
    subagents: cli === 'claude' ? 'Agent/Task；子代理回合不计入主会话上限' : cli === 'codex' ? '原生 spawn_agent；角色模型依原生配置' : '原生 subagent；独立步骤与权限，模型依原生配置' };
}
export function validateSnapshot(s: ExecutionSnapshot, entry?: Entry): void {
  if (!s || s.version !== 1 || !s.profile || (entry && s.entry !== entry) || !ENTRIES.includes(s.entry)) fail('执行快照入口缺失或不一致');
  validateConfiguration({ version: 1, revision: 0, profiles: [s.profile], global: {}, projects: {} });
  if (s.constraintMode !== undefined && !['native', 'strict'].includes(s.constraintMode)) fail('执行快照约束模式不合法');
  if (s.profile.state === 'draft') fail('草稿配置不能执行');
  if (s.profile.state === 'active' && !s.profile.validation?.entries.includes(s.entry)) fail('执行快照缺少对应入口的验证');
  if (s.profile.state === 'active' && s.profile.validation?.resolved?.[s.entry] !== s.model) fail('执行快照模型不匹配用途验证');
  if (typeof s.model !== 'string' || !s.model.trim() || s.tools !== ENTRY_DEFAULTS[s.entry].tools || typeof s.browser !== 'boolean' || !s.createdAt) fail('执行快照内容不合法');
  for (const n of [s.maxTurns, s.budgetUsd, s.timeoutMs]) if (!Number.isFinite(n) || n <= 0) fail('执行快照限制不合法');
}
export function validatePlan(plan: ExecutionPlan): void {
  if (!plan || Object.keys(plan).length !== ENTRIES.length) fail('执行计划不完整，不能读取当前默认配置代替');
  for (const entry of ENTRIES) validateSnapshot(plan[entry], entry);
}
export function assertExecutable(s: ExecutionSnapshot): void {
  validateSnapshot(s);
  assertRequirements(s);
  if (s.profile.state === 'active' && s.profile.validation?.account !== `${os.hostname()}/${os.userInfo().username}`) fail('配置未在当前运行账号验证，请重新探测');
}
