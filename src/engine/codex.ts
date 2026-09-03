import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_DIR, STAGES } from '../config.js';
import type { RunOutcome, TextRunOpts } from '../runner.js';
import { wireSchema } from '../schema.js';
import type { Envelope, Stage, StageResult } from '../types.js';
import type { Engine, TextResult } from './types.js';

/**
 * Codex CLI 引擎（`codex exec`，非交互）。与 claude 引擎的差异都收在这里：
 * - 结构化返回：`--output-schema` 传同一份 stage-result schema；最终消息用 `-o` 落文件再解析。
 * - 事件：`--json` 是 JSONL 事件流；thread.started 给会话 id，turn.completed 给 token 用量，turn.failed / error 是失败。
 * - 权限：没有按工具的白名单，只有沙箱级别——白名单含 Write/Edit/Bash 就 workspace-write，否则 read-only。
 * - 成本：Codex 只报 token，价格表来自环境变量（每百万 token 美元）；没配就记 0 并在 result 里注明「未计价」。
 * - 提示词交付：Codex 不认 `/pipeline-<stage>` 斜杠 skill，改为桥接提示词——让它先读插件里那份 SKILL.md 再照做。
 * 事件字段名以 codex-cli 0.152 实测（2026-09-03）为准，解析全部防御式：缺什么就给保守值，绝不抛。
 */

export interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  item?: { type?: string; text?: string };
}

export interface CodexSummary {
  sessionId?: string;
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  errorMessage?: string;
  lastAgentText?: string;
}

/** 把 JSONL 事件流归纳成一份摘要（纯函数，测试用） */
export function summarizeCodexEvents(jsonl: string): CodexSummary {
  const s: CodexSummary = { turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(t) as CodexEvent;
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) s.sessionId = ev.thread_id;
        break;
      case 'turn.completed':
        s.turns += 1;
        s.inputTokens += ev.usage?.input_tokens ?? 0;
        s.cachedInputTokens += ev.usage?.cached_input_tokens ?? 0;
        s.outputTokens += ev.usage?.output_tokens ?? 0;
        break;
      case 'turn.failed':
        s.errorMessage = ev.error?.message ?? s.errorMessage ?? 'turn.failed';
        break;
      case 'error':
        s.errorMessage = ev.message ?? s.errorMessage ?? 'error';
        break;
      case 'item.completed':
        if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') s.lastAgentText = ev.item.text;
        break;
      default:
        break;
    }
  }
  return s;
}

/** token → 美元。价格表：PIPELINE_CODEX_PRICE_IN / _CACHED / _OUT（每百万 token）；没配 → 0 */
export function codexCostUsd(s: CodexSummary, env = process.env): { usd: number; priced: boolean } {
  const pin = Number(env.PIPELINE_CODEX_PRICE_IN ?? 0);
  const pcached = Number(env.PIPELINE_CODEX_PRICE_CACHED ?? env.PIPELINE_CODEX_PRICE_IN ?? 0);
  const pout = Number(env.PIPELINE_CODEX_PRICE_OUT ?? 0);
  const priced = pin > 0 || pout > 0;
  const usd = ((s.inputTokens - s.cachedInputTokens) * pin + s.cachedInputTokens * pcached + s.outputTokens * pout) / 1_000_000;
  return { usd: priced ? Math.max(0, usd) : 0, priced };
}

/**
 * OpenAI 严格结构化输出对 schema 的要求（2026-09-03 真机报错 invalid_json_schema 实测）：
 * 每个 object 的 required 必须列出全部 properties；可选字段改成可空类型；`default` 等关键字不认。
 * 这里把契约 schema 转成严格形态，返回值里的 null 再由 stripNulls 剥回「缺省」——编排器那边一个字不改。
 */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  delete s.default;
  delete s.$schema;
  delete s.$id;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, unknown>;
    const required = new Set((s.required as string[] | undefined) ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      const strict = toStrictSchema(v) as Record<string, unknown>;
      if (!required.has(k)) {
        // 可选 → 可空：type 数组补 null；anyOf/oneOf 补一个 {type:null}
        if (typeof strict.type === 'string') strict.type = [strict.type, 'null'];
        else if (Array.isArray(strict.type)) strict.type = [...new Set([...(strict.type as string[]), 'null'])];
        else if (Array.isArray(strict.anyOf)) strict.anyOf = [...(strict.anyOf as unknown[]), { type: 'null' }];
        else if (Array.isArray(strict.oneOf)) strict.oneOf = [...(strict.oneOf as unknown[]), { type: 'null' }];
      }
      out[k] = strict;
    }
    s.properties = out;
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  if (s.items) s.items = toStrictSchema(s.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) s[key] = (s[key] as unknown[]).map(toStrictSchema);
  }
  return s;
}

/** 严格模式下可选字段回来是 null；契约里它们是「缺省」，剥掉以免校验与路由把 null 当值 */
export function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripNulls) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null) continue;
      out[k] = stripNulls(x);
    }
    return out as T;
  }
  return v;
}

/** 工具白名单 → 沙箱级别 */
export function sandboxFor(tools: string): 'read-only' | 'workspace-write' {
  return /\b(Write|Edit|Bash|NotebookEdit)\b/.test(tools) ? 'workspace-write' : 'read-only';
}

/**
 * Claude 斜杠 skill 提示词 → Codex 桥接提示词：让它先完整读插件里的 SKILL.md 再照做。
 * `${CLAUDE_PLUGIN_ROOT}` 与 superpowers 引用在文里说明；非斜杠提示词原样返回。
 */
export function bridgePrompt(prompt: string, pluginDir = PLUGIN_DIR): string {
  const m = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(prompt.trim());
  if (!m) return prompt;
  const skillFile = path.join(pluginDir, 'skills', m[1], 'SKILL.md').replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  return [
    `你是开发流水线的执行者，本次任务由 skill「${m[1]}」定义。先完整读取 ${skillFile}，然后严格按它执行。`,
    `读 skill 时的约定：文中 \${CLAUDE_PLUGIN_ROOT} 指 ${pluginDir.replace(/\\/g, '/')}；文中引用的 superpowers:<名字> skill，优先读 ${home}/.codex/superpowers 或 ${home}/.codex/skills 下同名目录的 SKILL.md，找不到就按其字面要求自行完成；文中提到的「子代理 / Agent 工具」在本环境不可用，由你在单一会话内顺序完成同等工作并在产物里如实说明。`,
    `参数：${m[2].trim() || '（无）'}`,
    '最终回复必须是且仅是符合给定 JSON Schema 的对象；产物文件按 skill 要求写进仓库。',
  ].join('\n');
}

interface ExecOpts {
  cwd: string;
  prompt: string;
  sandbox: 'read-only' | 'workspace-write';
  model?: string;
  schema?: object;
  resumeSessionId?: string;
  timeoutMs: number;
}

interface ExecOutcome {
  summary: CodexSummary;
  lastMessage: string;
  exitCode: number | null;
  stderr: string;
}

function codexModel(): string | undefined {
  return process.env.PIPELINE_CODEX_MODEL || undefined; // 不配就用 ~/.codex/config.toml 的默认模型
}

function execCodex(o: ExecOpts): Promise<ExecOutcome> {
  const tag = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const lastFile = path.join(os.tmpdir(), `pipeline-codex-last-${tag}.txt`);
  const schemaFile = o.schema ? path.join(os.tmpdir(), `pipeline-codex-schema-${tag}.json`) : null;
  if (schemaFile && o.schema) fs.writeFileSync(schemaFile, JSON.stringify(o.schema), 'utf-8');
  const common = [
    '--json',
    '--skip-git-repo-check',
    '-C',
    o.cwd,
    '-s',
    o.sandbox,
    ...(o.model ? ['-m', o.model] : []),
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-o',
    lastFile,
  ];
  const args = o.resumeSessionId ? ['exec', 'resume', ...common, o.resumeSessionId, o.prompt] : ['exec', ...common, o.prompt];
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf-8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let lastMessage = '';
      try {
        lastMessage = fs.readFileSync(lastFile, 'utf-8');
      } catch {
        /* 失败时没有最终消息 */
      }
      for (const f of [lastFile, schemaFile]) {
        if (f) {
          try {
            fs.unlinkSync(f);
          } catch {
            /* 已删 */
          }
        }
      }
      resolve({ summary: summarizeCodexEvents(out), lastMessage, exitCode: code, stderr: err });
    });
  });
}

/** 把一次执行的结果装进编排器认的 Envelope */
export function toEnvelope(r: ExecOutcome, parseStructured: boolean): Envelope {
  const { summary } = r;
  const cost = codexCostUsd(summary);
  const text = r.lastMessage.trim() || summary.lastAgentText?.trim() || '';
  const failed = !!summary.errorMessage || (r.exitCode !== 0 && !text);
  let structured: StageResult | undefined;
  if (parseStructured && !failed && text) {
    try {
      structured = stripNulls(JSON.parse(text.slice(text.indexOf('{'))) as StageResult);
    } catch {
      structured = undefined;
    }
  }
  const note = cost.priced ? '' : '（Codex 未配价格表 PIPELINE_CODEX_PRICE_IN/OUT，成本记 0）';
  return {
    is_error: failed,
    num_turns: summary.turns,
    total_cost_usd: cost.usd,
    session_id: summary.sessionId ?? 'codex',
    structured_output: structured,
    permission_denials: [],
    result: failed ? `Codex 执行失败：${summary.errorMessage ?? (r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`)}` : `${text}${note}`,
  };
}

const STAGE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export const codexEngine: Engine = {
  name: 'codex',
  async runStage(repo, ticket, stage: Exclude<Stage, 'ci'>, extraArgs = '', modelOverride?: string): Promise<RunOutcome> {
    const cfg = STAGES[stage];
    const r = await execCodex({
      cwd: repo,
      prompt: bridgePrompt(`/pipeline-${stage} ${ticket}${extraArgs ? ' ' + extraArgs : ''}`),
      sandbox: sandboxFor(cfg.tools),
      model: modelOverride && !/^(opus|sonnet|haiku)$/i.test(modelOverride) ? modelOverride : codexModel(),
      schema: toStrictSchema(JSON.parse(wireSchema())) as object,
      timeoutMs: STAGE_TIMEOUT_MS,
    });
    return { envelope: toEnvelope(r, true), rawStdout: r.lastMessage };
  },
  async runText(opts: TextRunOpts): Promise<TextResult> {
    const r = await execCodex({
      cwd: opts.cwd,
      prompt: bridgePrompt(opts.prompt, opts.pluginDir),
      sandbox: sandboxFor(opts.tools),
      model: codexModel(),
      resumeSessionId: opts.resumeSessionId,
      timeoutMs: 60 * 60 * 1000,
    });
    if (opts.resumeSessionId && r.summary.errorMessage && !r.summary.sessionId) {
      // 与 claude 引擎同一约定：resume 的启动期失败 reject，调用方降级为拼接模式
      throw new Error(`codex resume 失败：${r.summary.errorMessage}`);
    }
    const env = toEnvelope(r, false);
    return { text: env.result ?? '(无输出)', costUsd: env.total_cost_usd, turns: env.num_turns, isError: env.is_error, sessionId: env.session_id };
  },
};
