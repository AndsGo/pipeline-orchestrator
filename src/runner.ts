import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_DIR, RUNNER_SETTINGS, STAGE_EFFORT, STAGES } from './config.js';
import { e2eEnabledFor, writeClaudeMcpConfig } from './engine/e2e.js';
import { wireSchema } from './schema.js';
import type { Envelope, Stage } from './types.js';


export interface RunOutcome {
  envelope: Envelope;
  rawStdout: string;
}

/** shell 单引号包裹 */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 提示词落临时文件、由 bash 重定向进 claude 的标准输入（`claude -p … < file`），不再拼进命令行。
 * 2026-09-07 实测：bash -c 的命令串在本机约 8190 字符处被截断，尾巴的闭合引号没了 →
 * "unexpected EOF while looking for matching `''"。建单草拟把五轮对话拼进提示词（10670 字符）就炸了；
 * 续聊降级拼接、注入知识多的 /run 同样会撞。stdin 读提示词对新会话与 --resume 都验证过，session_id 不变。
 */
function promptFile(prompt: string): string {
  const f = path
    .join(os.tmpdir(), `pipeline-prompt-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`)
    .replace(/\\/g, '/');
  fs.writeFileSync(f, prompt, 'utf-8');
  return f;
}

function unlinkQuiet(f: string): void {
  try {
    fs.unlinkSync(f);
  } catch {
    /* 已删或被占用 */
  }
}

export interface ClaudeJsonOpts {
  cwd: string;
  prompt: string;
  tools: string;
  model: string;
  maxTurns: number;
  budgetUsd: number;
  /** 结构化输出 schema（对象，顶层不得含 allOf） */
  schema: object;
  /** 可选：加载 plugin（阶段 skill 需要） */
  pluginDir?: string;
  /** 可选：MCP 配置文件（浏览器 e2e 用）；给了就 --strict-mcp-config，只挂这一份 */
  mcpConfigFile?: string;
}

/** 通用：跑一次 headless claude 并拿结构化 JSON（供 runStage / 分诊 / 快车道复用） */
export function runClaudeJson(opts: ClaudeJsonOpts): Promise<RunOutcome> {
  const schemaFile = path
    .join(os.tmpdir(), `pipeline-schema-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
    .replace(/\\/g, '/');
  fs.writeFileSync(schemaFile, JSON.stringify(opts.schema), 'utf-8');
  const pf = promptFile(opts.prompt);
  const cmd = [
    'claude',
    '-p',
    ...(opts.pluginDir ? ['--plugin-dir', shq(opts.pluginDir)] : []),
    // 浏览器 e2e：只挂我们给的 MCP，不继承用户全局的（2026-09-05 探针配方）
    ...(opts.mcpConfigFile ? ['--mcp-config', shq(opts.mcpConfigFile.replace(/\\/g, '/')), '--strict-mcp-config'] : []),
    // 禁用会抢流控的插件层（engineering-workflow 等）：消除双流控串线，每会话省下 13.6KB 元技能注入
    '--settings',
    shq(RUNNER_SETTINGS.replace(/\\/g, '/')),
    '--output-format',
    'json',
    '--allowedTools',
    shq(opts.tools),
    '--model',
    opts.model,
    // 推理档位显式钉住，不继承交互用的全局 effortLevel（理由见 config.STAGE_EFFORT）
    '--effort',
    STAGE_EFFORT,
    '--max-turns',
    String(opts.maxTurns),
    '--max-budget-usd',
    String(opts.budgetUsd),
    '--json-schema',
    `"$(cat ${shq(schemaFile)})"`,
    '<',
    shq(pf),
  ].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    child.on('error', reject);
    child.on('close', (code) => {
      unlinkQuiet(schemaFile);
      unlinkQuiet(pf);
      const start = stdout.indexOf('{"');
      if (start < 0) {
        reject(new Error(`claude 无 JSON 输出（exit ${code}）：${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
        return;
      }
      try {
        resolve({ envelope: JSON.parse(stdout.slice(start)) as Envelope, rawStdout: stdout });
      } catch (e) {
        reject(new Error(`claude 输出 JSON 解析失败：${(e as Error).message}`));
      }
    });
  });
}

/**
 * headless 调起一个阶段 skill。
 * 试跑教训已内建：schema 内联传参、spawn 免 shell 引号问题、stdout 从首个 JSON 起解析。
 */
export interface TextRunOpts {
  cwd: string;
  prompt: string;
  tools: string;
  model: string;
  maxTurns: number;
  budgetUsd: number;
  pluginDir?: string;
  /**
   * 续接既有会话（claude -p --resume）：完整对话历史从盘上恢复，跨进程、跨 daemon 重启有效。
   * 实测（2026-08-19）：续完 session_id 不变；id 无效时 CLI 输出纯文本报错 + exit 1，
   * 走不到 JSON 解析即 reject——调用方以此降级回拼接模式。
   */
  resumeSessionId?: string;
}

/**
 * 单次执行：拿自由文本结果，不走结构化契约。
 * 用于"问一句/跑个测试/跑个 skill"这类不值得建工单的小事。
 */
export function runClaudeText(
  opts: TextRunOpts,
): Promise<{ text: string; costUsd: number; turns: number; isError: boolean; sessionId?: string }> {
  const pf = promptFile(opts.prompt);
  const cmd = [
    'claude',
    '-p',
    ...(opts.resumeSessionId ? ['--resume', shq(opts.resumeSessionId)] : []),
    ...(opts.pluginDir ? ['--plugin-dir', shq(opts.pluginDir)] : []),
    // 禁用会抢流控的插件层（engineering-workflow 等）：消除双流控串线，每会话省下 13.6KB 元技能注入
    '--settings',
    shq(RUNNER_SETTINGS.replace(/\\/g, '/')),
    '--output-format',
    'json',
    '--allowedTools',
    shq(opts.tools),
    '--model',
    opts.model,
    '--effort',
    STAGE_EFFORT,
    '--max-turns',
    String(opts.maxTurns),
    '--max-budget-usd',
    String(opts.budgetUsd),
    '<',
    shq(pf),
  ].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf-8')));
    child.on('error', reject);
    child.on('close', (code) => {
      unlinkQuiet(pf);
      const start = out.indexOf('{"');
      if (start < 0) {
        reject(new Error(`claude 无输出（exit ${code}）：${(err || out).slice(0, 300)}`));
        return;
      }
      try {
        const env = JSON.parse(out.slice(start)) as Envelope;
        // is_error 必须回传：会话中途断线时 result 里装的是报错文案，
        // 不看这个标志就会把"API Error: Connection lost"当成正常执行结果发出去
        resolve({
          text: env.result ?? '(无输出)',
          costUsd: env.total_cost_usd ?? 0,
          turns: env.num_turns ?? 0,
          isError: env.is_error === true,
          sessionId: env.session_id,
        });
      } catch (e) {
        reject(new Error(`结果解析失败：${(e as Error).message}`));
      }
    });
  });
}

export async function runStage(
  repo: string,
  ticket: string,
  stage: Exclude<Stage, 'ci'>,
  extraArgs = '',
  /** 覆盖本阶段模型（implement 对照实验用；缺省走 STAGES 配置） */
  modelOverride?: string,
): Promise<RunOutcome> {
  const cfg = STAGES[stage];
  // 项目约定 e2e: playwright → 验收/评审带浏览器：MCP 配置临时落盘，白名单放行 mcp__playwright（该 server 的全部工具）
  const e2e = e2eEnabledFor(repo, stage);
  const mcpConfigFile = e2e ? writeClaudeMcpConfig() : undefined;
  try {
    return await runClaudeJson({
      cwd: repo,
      prompt: `/pipeline-${stage} ${ticket}${extraArgs ? ' ' + extraArgs : ''}`,
      pluginDir: PLUGIN_DIR,
      tools: e2e ? `${cfg.tools},mcp__playwright` : cfg.tools,
      model: modelOverride ?? cfg.model,
      maxTurns: cfg.maxTurns,
      budgetUsd: cfg.budgetUsd,
      schema: JSON.parse(wireSchema()) as object,
      mcpConfigFile,
    });
  } finally {
    if (mcpConfigFile) {
      try {
        fs.unlinkSync(mcpConfigFile);
      } catch {
        /* 已删 */
      }
    }
  }
}
