import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputConfigurationConflictError, readOutputConfiguration, resolveOutput, validateOutputConfiguration, writeOutputConfiguration } from '../output/configuration.js';
import { bindOutputMessage, createOutputRecord, listOutputRecords, readOutputRecord, renderOutput, type OutputDraft } from '../output/records.js';
import { composeOutputInstructions, extractOutputOverride, parseOutputResponse } from '../output/presentation.js';

let root: string;
let repo: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-output-'));
  repo = path.join(root, 'repo');
  vi.stubEnv('PIPELINE_DATA_DIR', root);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const draft = (): OutputDraft => ({ repo, stage: 'answer', title: '结果', summary: '可以继续。', detail: '完整实现和验证说明。', risks: ['生产验证尚未完成。'], actions: ['请确认上线时间。'], evidence: ['运行 npm test，检查通过。'] });

describe('output configuration', () => {
  it('defaults to concise without creating a file and inherits by specificity for every stage', () => {
    expect(readOutputConfiguration()).toEqual({ version: 1, revision: 0, defaultLevel: 'concise', projects: {} });
    expect(fs.existsSync(path.join(root, 'output-config.json'))).toBe(false);
    const config = { ...readOutputConfiguration(), revision: 3, defaultLevel: 'professional' as const, projects: { [repo]: { defaultLevel: 'concise' as const, stages: { confirmation: 'professional' as const } } } };
    expect(resolveOutput(undefined, 'answer', undefined, config)).toEqual({ level: 'professional', source: 'global.default', revision: 3 });
    for (const stage of ['answer', 'intake', 'delivery'] as const) expect(resolveOutput(repo, stage, undefined, config)).toEqual({ level: 'concise', source: 'project.default', revision: 3 });
    expect(resolveOutput(repo, 'confirmation', undefined, config)).toEqual({ level: 'professional', source: 'project.stage', revision: 3 });
    expect(resolveOutput(repo, 'confirmation', 'concise', config)).toEqual({ level: 'concise', source: 'override', revision: 3 });
  });

  it('hot reads atomic revision writes, rejects stale writers and leaves existing lock owners intact', () => {
    const first = writeOutputConfiguration(0, { ...readOutputConfiguration(), defaultLevel: 'professional' });
    expect(first.revision).toBe(1);
    expect(resolveOutput(repo, 'intake').level).toBe('professional');
    expect(() => writeOutputConfiguration(0, first)).toThrow(OutputConfigurationConflictError);
    expect(readOutputConfiguration()).toEqual(first);
    const file = path.join(root, 'output-config.json');
    expect(fs.readdirSync(root)).toEqual(['output-config.json']);
    fs.writeFileSync(`${file}.lock`, 'another process');
    expect(() => writeOutputConfiguration(1, first)).toThrowError(expect.objectContaining({ code: 'OUTPUT_CONFIG_CONFLICT' }));
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe('another process');
    fs.unlinkSync(`${file}.lock`);
    writeOutputConfiguration(1, { ...first, defaultLevel: 'concise' });
    expect(resolveOutput(repo, 'intake')).toEqual({ level: 'concise', source: 'global.default', revision: 2 });
  });

  it('rejects invalid paths, keys, stages and malformed config instead of silently falling back', () => {
    const config = readOutputConfiguration();
    for (const invalid of [
      { ...config, defaultLevel: 'verbose' }, { ...config, revision: -1 }, { ...config, audience: 'developer' },
      { ...config, projects: { relative: {} } }, { ...config, projects: { [repo]: { stages: { implement: 'concise' } } } },
      { ...config, projects: { [repo]: { stages: [] } } }, { ...config, projects: { [repo]: { model: 'test' } } },
    ]) expect(() => validateOutputConfiguration(invalid)).toThrow();
    expect(() => writeOutputConfiguration(0, { ...config, projects: { [repo]: { stages: { answer: 'invalid' } } } })).toThrow();
    expect(fs.existsSync(path.join(root, 'output-config.json.lock'))).toBe(false);
    fs.writeFileSync(path.join(root, 'output-config.json'), '{broken');
    expect(() => readOutputConfiguration()).toThrow('读取失败');
  });
});

describe('output records', () => {
  it('persists full material and frozen settings across an independent process', () => {
    const frozen = resolveOutput(repo, 'answer');
    writeOutputConfiguration(0, { ...readOutputConfiguration(), defaultLevel: 'professional' });
    const input = draft();
    const record = createOutputRecord(input, { chatId: 'chat-a' }, frozen);
    input.risks.push('later mutation');
    const script = `import {readOutputRecord} from './src/output/records.ts'; console.log(JSON.stringify(readOutputRecord(${JSON.stringify(record.id)})));`;
    const restored = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd(), env: process.env }));
    expect(restored).toEqual(record);
    expect(record).toMatchObject({ level: 'concise', levelSource: 'global.default', configRevision: 0, chatId: 'chat-a', detail: input.detail, risks: ['生产验证尚未完成。'] });
    expect(createOutputRecord(draft()).level).toBe('professional');
    expect(listOutputRecords()).toHaveLength(2);
  });

  it('binds a message atomically, is idempotent and refuses rebinding or path traversal', () => {
    const record = createOutputRecord(draft());
    expect(bindOutputMessage(record.id, 'message-a')).toEqual({ ...record, messageId: 'message-a' });
    expect(bindOutputMessage(record.id, 'message-a').messageId).toBe('message-a');
    expect(() => bindOutputMessage(record.id, 'message-b')).toThrow('已绑定');
    expect(readOutputRecord(record.id)).toEqual({ ...record, messageId: 'message-a' });
    expect(readOutputRecord('../output-config')).toBeNull();
    expect(readOutputRecord('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(fs.readdirSync(path.join(root, 'outputs'))).toEqual([`${record.id}.json`]);
  });

  it('keeps every risk and action in both levels without truncating, with detail/evidence in professional', () => {
    const risk = `关键风险：${'不可丢失。'.repeat(1500)}`;
    const record = createOutputRecord({ ...draft(), risks: [risk, '另一个风险'], actions: ['必须由用户确认'], override: 'professional' });
    const concise = renderOutput(record, 'concise');
    const professional = renderOutput(record);
    for (const text of [concise, professional]) { expect(text).toContain(record.summary); expect(text).toContain(risk); expect(text).toContain('另一个风险'); expect(text).toContain('必须由用户确认'); }
    expect(concise).not.toContain(record.detail);
    expect(concise).not.toContain(record.evidence[0]);
    expect(professional).toContain(record.detail);
    expect(professional).toContain(record.evidence[0]);
    expect(() => createOutputRecord({ ...draft(), summary: ' ', detail: '' })).toThrow();
  });

  it('keeps unstructured and historical material as full detail with an explicit missing-summary notice', () => {
    const record = createOutputRecord({ ...draft(), summary: '', detail: '历史原文。\n风险只记录在历史原文中。' });
    const file = path.join(root, 'outputs', `${record.id}.json`);
    const { summary: _summary, ...historical } = record;
    fs.writeFileSync(file, JSON.stringify(historical));
    const restored = readOutputRecord(record.id)!;
    expect(restored.summary).toBe('');
    for (const level of ['concise', 'professional'] as const) {
      expect(renderOutput(restored, level)).toContain('未提供结构化摘要，以下为原始输出');
      expect(renderOutput(restored, level)).toContain(record.detail);
    }
    expect(listOutputRecords()).toEqual([restored]);
  });
});

describe('output presentation protocol', () => {
  const result = { summary: '摘要', detail: '完整正文', risks: ['风险'], actions: ['确认'], evidence: ['测试结果'] };
  it('accepts complete JSON and output-result fences, preserving all material', () => {
    const json = JSON.stringify(result);
    expect(parseOutputResponse(json)).toEqual(result);
    expect(parseOutputResponse(`\`\`\`output-result\n${json}\n\`\`\``)).toEqual(result);
    expect(parseOutputResponse(`\`\`\`json\n${json}\n\`\`\``)).toEqual(result);
    expect(composeOutputInstructions()).toContain('所有关键风险');
    expect(composeOutputInstructions()).toContain('不能仅放在 detail');
  });

  it('rejects missing summaries, wrong types, extra fields and historical prose without synthesizing an excerpt', () => {
    for (const value of [{ detail: '只有历史正文', risks: [], actions: [], evidence: [] }, { ...result, summary: ' ' }, { ...result, risks: '风险' }, { ...result, evidence: [4] }, { ...result, actions: [''] }, { ...result, extra: true }, null, []]) expect(parseOutputResponse(JSON.stringify(value))).toBeNull();
    expect(parseOutputResponse('历史正文第一段\n\n历史正文第二段')).toBeNull();
    expect(parseOutputResponse(`前言\n\`\`\`output-result\n${JSON.stringify(result)}\n\`\`\``)).toBeNull();
  });

  it('only selects explicit current requests, excluding quoted, negated, incidental or contradictory phrases', () => {
    for (const text of ['简单说', '这次请简单说一下。', '问题内容，给业务看', '请给业务看：结果是什么？']) expect(extractOutputOverride(text)).toBe('concise');
    for (const text of ['展开依据', '本次给开发看。', '请展开依据，解释原因']) expect(extractOutputOverride(text)).toBe('professional');
    for (const text of ['专业一点', '代码有什么问题', '不要展开依据', '“给开发看”是什么意思？', '同事让我给业务看文档', '简单说，展开依据', '示例：\n```text\n展开依据\n```', '`给业务看`']) expect(extractOutputOverride(text)).toBeUndefined();
  });
});
