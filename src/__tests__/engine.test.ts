import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgePrompt, codexCommand, codexCostUsd, reconcileWorktreeArtifacts, sandboxArgs,
  sandboxFor, stripOptionalNulls, summarizeCodexEvents, toEnvelope, toStrictSchema } from '../engine/codex.js';
import { execSync } from 'node:child_process';
import fsMod from 'node:fs';
import osMod from 'node:os';
import pathMod from 'node:path';
import { validateResult, wireSchema } from '../schema.js';
import { engineFor, engineNamed } from '../engine/index.js';
import { parseProfile } from '../profile.js';

describe('引擎选择（PIPELINE.md 的 engine / engine.<stage>）', () => {
  it('缺省 claude；未知名字回落 claude 而不是抛', () => {
    expect(engineNamed(undefined).name).toBe('claude');
    expect(engineNamed('Codex').name).toBe('codex');
    expect(engineNamed('gemini').name).toBe('claude');
    expect(engineFor(undefined).name).toBe('claude');
  });

  it('profile 解析：engine 全局 + engine.<stage> 覆盖（扁平点号键）', () => {
    const p = parseProfile('---\nengine: codex   # 注释\nengine.review: claude\nengine.Plan: CODEX\n---\n## 全阶段\nx');
    expect(p.engine).toEqual({ default: 'codex', byStage: { review: 'claude', plan: 'codex' } });
    expect(parseProfile('---\nrelease: none\n---').engine).toEqual({ default: null, byStage: {} });
  });

  it('engineFor 按仓库约定选：阶段覆盖优先于全局，没有约定文件 → claude', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
    try {
      expect(engineFor(dir, 'review').name).toBe('claude');
      fs.mkdirSync(path.join(dir, 'docs', 'pipeline'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', 'pipeline', 'PIPELINE.md'), '---\nengine: claude\nengine.review: codex\n---\n', 'utf-8');
      expect(engineFor(dir, 'review').name).toBe('codex');
      expect(engineFor(dir, 'implement').name).toBe('claude');
      expect(engineFor(dir).name).toBe('claude');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Codex 引擎的纯函数部分', () => {
  const failedRun = [
    '{"type":"thread.started","thread_id":"01a066a9-3949-77b2-b391-4979b7df41c1"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Your access token could not be refreshed"}',
    '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed"}}',
  ].join('\n');
  // 成功样本按 codex-cli 0.152 真机探针（2026-09-03）：usage 还带 cache_write_input_tokens / reasoning_output_tokens，解析器忽略即可
  const okRun = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"stage\\":\\"review\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":0,"output_tokens":200,"reasoning_output_tokens":0}}',
    'not json',
  ].join('\n');

  it('事件归纳：失败样本（2026-09-03 实测）与成功样本', () => {
    const f = summarizeCodexEvents(failedRun);
    expect(f.sessionId).toBe('01a066a9-3949-77b2-b391-4979b7df41c1');
    expect(f.errorMessage).toContain('access token');
    expect(f.turns).toBe(0);
    const s = summarizeCodexEvents(okRun);
    expect(s).toMatchObject({ sessionId: 't-1', turns: 1, inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });
    expect(s.lastAgentText).toBe('{"stage":"review"}');
  });

  it('成本：没配价格表记 0 并标记未计价；配了按 (非缓存输入·输入价 + 缓存·缓存价 + 输出·输出价)/1e6', () => {
    const s = summarizeCodexEvents(okRun);
    expect(codexCostUsd(s, {} as NodeJS.ProcessEnv)).toEqual({ usd: 0, priced: false });
    const c = codexCostUsd(s, { PIPELINE_CODEX_PRICE_IN: '2', PIPELINE_CODEX_PRICE_CACHED: '0.5', PIPELINE_CODEX_PRICE_OUT: '8' } as NodeJS.ProcessEnv);
    expect(c.priced).toBe(true);
    expect(c.usd).toBeCloseTo((600 * 2 + 400 * 0.5 + 200 * 8) / 1e6, 9);
  });

  it('严格 schema：每个 object 的 required 覆盖全部属性，可选字段变可空，default/$schema 剥掉（2026-09-03 invalid_json_schema 实测）', () => {
    const strict = toStrictSchema(JSON.parse(wireSchema())) as { required: string[]; properties: Record<string, { type: unknown }>; $schema?: unknown };
    expect(strict.$schema).toBeUndefined();
    expect(new Set(strict.required)).toEqual(new Set(Object.keys(strict.properties)));
    expect(strict.properties.stage.type).toBe('string'); // 原本 required 的不动
    expect(strict.properties.open_questions.type).toEqual(['array', 'null']); // 原本可选的变可空
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      expect(o).not.toHaveProperty('default');
      if (o.type === 'object' && o.properties) expect(new Set(o.required as string[])).toEqual(new Set(Object.keys(o.properties as object)));
      Object.values(o).forEach(walk);
    };
    walk(strict);
  });

  it('stripOptionalNulls：只剥原本可选字段的 null；必填可空（axes.spec.worst）保留——真机干跑返回过契约校验', () => {
    // codex-cli 0.152 对严格 schema 的真实返回（2026-09-03）
    const fromCodex = JSON.parse(
      '{"stage":"review","status":"DONE","handoff_path":"docs/pipeline/T-0/30-review-r1.md","summary_for_card":"契约干跑","open_questions":null,"concerns":[],"blocked_reason":null,"verdict":"PASS","axes":{"spec":{"total":0,"failed":0,"worst":null},"quality":{"critical":0,"important":0,"minor":0,"worst":null}}}',
    );
    const cleaned = stripOptionalNulls(fromCodex, JSON.parse(wireSchema())) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty('open_questions');
    expect(cleaned).not.toHaveProperty('blocked_reason');
    expect((cleaned.axes as { spec: { worst: unknown } }).spec.worst).toBeNull();
    expect(validateResult(cleaned as never)).toEqual([]);
  });

  it('起进程不经 shell：优先 node + 全局 codex.js；PIPELINE_CODEX_BIN 可指定（LS-014 评审死于 shell 拆参数，2026-09-04）', () => {
    const node = 'D:/nvm/v24/node.exe';
    expect(codexCommand({} as NodeJS.ProcessEnv, node, (p) => p.endsWith('codex.js'))).toEqual({
      cmd: node,
      prefix: ['D:/nvm/v24/node_modules/@openai/codex/bin/codex.js'.replace(/\//g, path.sep)],
    });
    expect(codexCommand({ PIPELINE_CODEX_BIN: 'C:/x/codex.js' } as NodeJS.ProcessEnv, node, () => false)).toEqual({ cmd: node, prefix: ['C:/x/codex.js'] });
    expect(codexCommand({ PIPELINE_CODEX_BIN: '/usr/bin/codex' } as NodeJS.ProcessEnv, node, () => false)).toEqual({ cmd: '/usr/bin/codex', prefix: [] });
  });

  it('reconcileWorktreeArtifacts：Codex 写到主检出的工件搬回 worktree；worktree 已有的不覆盖（LS-015 实测）', () => {
    const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'wtrec-'));
    const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const main = pathMod.join(root, 'main');
      fsMod.mkdirSync(main, { recursive: true });
      sh(main, 'git init -q && git config user.email t@t && git config user.name t');
      fsMod.writeFileSync(pathMod.join(main, 'a.txt'), 'x');
      sh(main, 'git add . && git commit -q -m init');
      const wt = pathMod.join(root, 'wt');
      sh(main, `git worktree add -q "${wt}" -b feat`);
      const rel = pathMod.join('docs', 'pipeline', 'LS-9');
      // Codex 把评审写去了主检出；worktree 已有 clarify 的产物
      fsMod.mkdirSync(pathMod.join(main, rel), { recursive: true });
      fsMod.writeFileSync(pathMod.join(main, rel, '30-review-r1.md'), 'codex review');
      fsMod.writeFileSync(pathMod.join(main, rel, '10-prd.md'), '主检出的旧版');
      fsMod.mkdirSync(pathMod.join(wt, rel), { recursive: true });
      fsMod.writeFileSync(pathMod.join(wt, rel, '10-prd.md'), 'worktree 的真版');

      reconcileWorktreeArtifacts(wt, 'LS-9', () => {});

      // 评审搬回 worktree、从主检出移走
      expect(fsMod.readFileSync(pathMod.join(wt, rel, '30-review-r1.md'), 'utf-8')).toBe('codex review');
      expect(fsMod.existsSync(pathMod.join(main, rel, '30-review-r1.md'))).toBe(false);
      // worktree 已有的 10-prd.md 不被主检出版本覆盖
      expect(fsMod.readFileSync(pathMod.join(wt, rel, '10-prd.md'), 'utf-8')).toBe('worktree 的真版');
      // 非 worktree（传主检出自身）时安全返回，不动文件
      reconcileWorktreeArtifacts(main, 'LS-9', () => {});
      expect(fsMod.existsSync(pathMod.join(main, rel, '10-prd.md'))).toBe(true);
    } finally {
      fsMod.rmSync(root, { recursive: true, force: true });
    }
  });

  it('沙箱映射：含 Write/Edit/Bash → workspace-write，否则 read-only', () => {
    expect(sandboxFor('Read,Grep,Glob')).toBe('read-only');
    expect(sandboxFor('Read,Grep,Glob,Bash')).toBe('workspace-write');
    expect(sandboxFor('Read,Write,Edit')).toBe('workspace-write');
  });

  it('桥接提示词：斜杠 skill → 先读插件里的 SKILL.md；给了 cwd 时钉死工作根不许溜去别处写；非斜杠原样', () => {
    const p = bridgePrompt('/pipeline-review OP-9 base=abc', 'D:/plug', 'D:/work/repo-OP-9');
    expect(p).toContain('D:/plug/skills/pipeline-review/SKILL.md');
    expect(p).toContain('参数：OP-9 base=abc');
    expect(p).toContain('子代理');
    expect(p).toContain('D:/work/repo-OP-9');
    expect(p).toContain('绝不要 cd 过去写文件');
    expect(bridgePrompt('帮我看下这个仓库', 'D:/plug')).toBe('帮我看下这个仓库');
    expect(bridgePrompt('/pipeline-plan X', 'D:/plug')).not.toContain('绝不要 cd'); // 没给 cwd 就不加钉根这段
  });

  it('Envelope：失败 → is_error 带原话；成功 → 解析最终消息为结构化返回，未计价时在 result 注明', () => {
    const bad = toEnvelope({ summary: summarizeCodexEvents(failedRun), lastMessage: '', exitCode: 1, stderr: '' }, true);
    expect(bad.is_error).toBe(true);
    expect(bad.result).toContain('access token');
    const good = toEnvelope({ summary: summarizeCodexEvents(okRun), lastMessage: '{"stage":"review","status":"DONE"}\n', exitCode: 0, stderr: '' }, true);
    expect(good.is_error).toBe(false);
    expect(good.structured_output).toMatchObject({ stage: 'review', status: 'DONE' });
    expect(good.session_id).toBe('t-1');
    expect(good.result).toContain('未配价格表');
  });
});

describe('codex 沙箱参数与 --approve-for-me 互斥（2026-09-07 LS-016：review 配 codex + e2e 整轮失败）', () => {
  it('无 e2e：给 -s <级别>', () => {
    expect(sandboxArgs('read-only')).toEqual(['-s', 'read-only']);
    expect(sandboxArgs('workspace-write', ['-c', 'x'])).toEqual(['-s', 'workspace-write']);
  });
  it('e2e（extraArgs 含 --approve-for-me）：不给 -s，交给 --approve-for-me 治沙箱', () => {
    expect(sandboxArgs('read-only', ['--ignore-user-config', '--approve-for-me', '-c', 'y'])).toEqual([]);
  });
});
