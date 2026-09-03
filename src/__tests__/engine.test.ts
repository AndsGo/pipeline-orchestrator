import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgePrompt, codexCostUsd, sandboxFor, stripOptionalNulls, summarizeCodexEvents, toEnvelope, toStrictSchema } from '../engine/codex.js';
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

  it('沙箱映射：含 Write/Edit/Bash → workspace-write，否则 read-only', () => {
    expect(sandboxFor('Read,Grep,Glob')).toBe('read-only');
    expect(sandboxFor('Read,Grep,Glob,Bash')).toBe('workspace-write');
    expect(sandboxFor('Read,Write,Edit')).toBe('workspace-write');
  });

  it('桥接提示词：斜杠 skill → 先读插件里的 SKILL.md；非斜杠原样', () => {
    const p = bridgePrompt('/pipeline-review OP-9 base=abc', 'D:/plug');
    expect(p).toContain('D:/plug/skills/pipeline-review/SKILL.md');
    expect(p).toContain('参数：OP-9 base=abc');
    expect(p).toContain('子代理');
    expect(bridgePrompt('帮我看下这个仓库', 'D:/plug')).toBe('帮我看下这个仓库');
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
