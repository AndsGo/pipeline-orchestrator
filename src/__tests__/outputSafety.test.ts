import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackOutputResponse, parseOutputResponse } from '../output/presentation.js';
import { readOutputConfiguration, writeOutputConfiguration, type OutputResolution } from '../output/configuration.js';
import { listOutputRecords } from '../output/records.js';
import { FeishuPort } from '../feishu/port.js';
import { Semaphore } from '../semaphore.js';
import { runTicket, type RunTicketOpts } from '../ticketRunner.js';
import { readSnapshot } from '../ticket.js';
import { setPaused } from '../pause.js';
import { ticketDir } from '../config.js';
import type { DaemonContext } from '../daemon/context.js';
import type { InteractionPort } from '../ports.js';
import type { StageResult } from '../types.js';

const model = vi.hoisted(() => ({ runText: vi.fn(), runJson: vi.fn() }));
vi.mock('../engine/index.js', () => ({ engineFor: vi.fn(() => model) }));
const { execAdhoc } = await import('../daemon/adhoc.js');
let root: string;
let repo: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-safety-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('PIPELINE_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('PIPELINE_AGENT_CONFIG_FILE', path.join(root, 'agent-config.json'));
  for (const key of ['BITABLE_APP_TOKEN', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'PREVIEW_BASE_URL', 'CONSOLE_BASE_URL', 'PIPELINE_DOUBLE_REVIEW']) vi.stubEnv(key, '');
  model.runText.mockReset();
  model.runJson.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
function selectProfessional() {
  const config = readOutputConfiguration();
  writeOutputConfiguration(config.revision, { ...config, defaultLevel: 'professional' });
}
const legacy = '历史正文第一段\n\n第二段包含未验证风险。';
const internal = 'private-tool://handoff?secret=do-not-publish';
const malformed = JSON.stringify({ summary: '业务结论', detail: '业务说明', risks: ['仍需实测'], actions: ['请确认'], internalHandoff: internal });
const irregular = JSON.stringify({ summary: '完成', detail: '已提交', risks: '尚未执行迁移，禁止上线', actions: { next: '先安排备份' }, internalHandoff: 'internal-tool-only' });

describe('safe output fallback', () => {
  it('preserves legacy prose and complete sanitized JSON from incomplete structured responses', () => {
    expect(fallbackOutputResponse(legacy).detail).toBe(legacy);
    expect(parseOutputResponse(malformed)).toBeNull();
    expect(fallbackOutputResponse(malformed)).toEqual({ summary: '', detail: JSON.stringify({ summary: '业务结论', detail: '业务说明', risks: ['仍需实测'], actions: ['请确认'] }, null, 2), risks: ['仍需实测'], actions: ['请确认'], evidence: [] });
    expect(JSON.stringify(fallbackOutputResponse(malformed))).not.toContain(internal);
  });

  it('retains non-array risks, object actions and unknown business fields while stripping nested handoffs', () => {
    const safe = fallbackOutputResponse(irregular);
    expect(safe.summary).toBe('');
    expect(JSON.parse(safe.detail)).toEqual({ summary: '完成', detail: '已提交', risks: '尚未执行迁移，禁止上线', actions: { next: '先安排备份' } });
    expect(safe.detail).not.toContain('internal-tool-only');
    const nested = { review: { warning: '未知业务字段不能丢', internalHandoff: internal }, checks: [{ result: '待备份', internalHandoff: internal }] };
    expect(JSON.parse(fallbackOutputResponse(JSON.stringify(nested)).detail)).toEqual({ review: { warning: '未知业务字段不能丢' }, checks: [{ result: '待备份' }] });
  });

  it('withholds unreliable internal handoff syntax rather than publishing the raw response', () => {
    for (const text of [malformed.slice(0, -1), `前言\n\`\`\`output-result\n${malformed}\n\`\`\``, '{"internal\\u0048andoff":"private",']) {
      const safe = fallbackOutputResponse(text);
      expect(safe.detail).toContain('输出格式异常');
      expect(safe.detail).toContain('仅在内部留档');
      expect(JSON.stringify(safe)).not.toContain('private');
    }
  });

  it('sends and stores sanitized business material while retaining the full original in internal logs', async () => {
    const sent: string[] = [];
    const client = { im: { message: { create: async (req: { data: { content: string } }) => { sent.push(req.data.content); return { data: { message_id: `m-${sent.length}` } }; } } } };
    const port = new FeishuPort(client as never, null, { appId: 'test', appSecret: 'test', chatId: 'chat' });
    const project = { alias: 'demo', repo, prefix: 'DEMO' };
    const ctx = { port, projects: [project], cfg: { defaultProject: 'demo', maxConcurrency: 1 }, sem: new Semaphore(1),
      log: () => {}, adhoc: [], active: new Map(), MAIN_CHAT: 'chat' } as unknown as DaemonContext;
    model.runText.mockResolvedValue({ text: irregular, turns: 1, costUsd: 0, isError: false, sessionId: 'session' });
    await execAdhoc(ctx, project, '查询', '查询', [], 0, { chat: 'chat' });
    expect(sent[0]).toContain('尚未执行迁移，禁止上线');
    expect(sent[0]).toContain('先安排备份');
    expect(sent[0]).not.toContain('internal-tool-only');
    expect(JSON.stringify(listOutputRecords())).not.toContain('internal-tool-only');
    const logs = fs.readdirSync(path.join(root, 'data', 'adhoc')).map(name => fs.readFileSync(path.join(root, 'data', 'adhoc', name), 'utf8')).join('\n');
    expect(logs).toContain('internal-tool-only');
  });
});

describe('stage output configuration freezes before model execution', () => {
  const port = (): InteractionPort => ({ askQuestions: vi.fn(async () => []), confirmGate: vi.fn(async () => ({ approved: true })), notify: vi.fn(async () => {}), close: () => {} });
  const envelope = (result: StageResult) => ({ envelope: { is_error: false, num_turns: 1, total_cost_usd: 0, session_id: 'fake-model', permission_denials: [], structured_output: result }, rawStdout: '' });

  it('keeps the first confirmation policy through a mid-model edit and persists the next policy on rerun', async () => {
    const ticket = 'FREEZE-1';
    const interaction = port();
    const seen: Array<{ resolution?: OutputResolution; persisted?: OutputResolution }> = [];
    interaction.confirmGate = async (_ticket, _gate, _summary, _risks, _detail, options) => {
      seen.push({ resolution: options?.resolution, persisted: readSnapshot(ticket)?.pendingGate?.outputResolution });
      if (seen.length === 2) setPaused(ticket, 'test completed');
      return { approved: false, note: '修订后重跑' };
    };
    const stageRunner: NonNullable<RunTicketOpts['stageRunner']> = vi.fn(async (_repo, _ticket, stage) => {
      if (!readOutputConfiguration().revision) selectProfessional();
      return envelope({ stage: stage as 'plan', status: 'DONE', handoff_path: `docs/pipeline/${ticket}/20-plan.md`, summary_for_card: '计划已整理' });
    });
    await runTicket({ repo, ticket, startStage: 'plan', lane: 'full', requirement: '测试冻结策略', port: interaction, stageRunner });
    expect(stageRunner).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      { resolution: { level: 'concise', source: 'global.default', revision: 0 }, persisted: { level: 'concise', source: 'global.default', revision: 0 } },
      { resolution: { level: 'professional', source: 'global.default', revision: 1 }, persisted: { level: 'professional', source: 'global.default', revision: 1 } },
    ]);
  });

  it('keeps the current delivery policy through a mid-model edit and uses the new policy next run', async () => {
    const stageRunner: NonNullable<RunTicketOpts['stageRunner']> = vi.fn(async (_repo, ticket) => {
      if (!readOutputConfiguration().revision) selectProfessional();
      fs.writeFileSync(path.join(ticketDir(repo, ticket), '95-delivery.md'), '# 完整交付材料');
      return envelope({ stage: 'compound', status: 'DONE', handoff_path: `docs/pipeline/${ticket}/90-retro.md`, summary_for_card: '交付完成' });
    });
    for (const ticket of ['FREEZE-2', 'FREEZE-3']) await runTicket({ repo, ticket, startStage: 'compound', lane: 'full', requirement: '测试交付冻结', port: port(), stageRunner });
    const records = listOutputRecords();
    expect(records.find(record => record.sourceRef === 'FREEZE-2')).toMatchObject({ level: 'concise', configRevision: 0 });
    expect(records.find(record => record.sourceRef === 'FREEZE-3')).toMatchObject({ level: 'professional', configRevision: 1 });
    expect(stageRunner).toHaveBeenCalledTimes(2);
  });

  it('routes fastlane completion through delivery output with a frozen policy and only existing result facts', async () => {
    const sent: string[] = [];
    const client = { im: { message: { create: async (req: { data: { content: string } }) => { sent.push(req.data.content); return { data: { message_id: `m-${sent.length}` } }; } } } };
    const interaction = new FeishuPort(client as never, null, { appId: 'test', appSecret: 'test', chatId: 'chat' });
    model.runJson.mockImplementation(async () => {
      if (!readOutputConfiguration().revision) selectProfessional();
      return { envelope: { is_error: false, num_turns: 1, total_cost_usd: 0, session_id: 'fast-session', structured_output: { status: 'DONE', summary_for_card: '文案修改已完成', branch: 'feat/fast-test', reason: '保留已有展示逻辑' } } };
    });
    const stageRunner = vi.fn();
    for (const ticket of ['FAST-1', 'FAST-2']) await runTicket({ repo, ticket, lane: 'fast', requirement: '调整文案', port: interaction, stageRunner });
    const records = listOutputRecords();
    const first = records.find(record => record.sourceRef === 'FAST-1')!;
    const second = records.find(record => record.sourceRef === 'FAST-2')!;
    expect(first).toMatchObject({ stage: 'delivery', level: 'concise', configRevision: 0, risks: [], actions: [] });
    expect(second).toMatchObject({ stage: 'delivery', level: 'professional', configRevision: 1 });
    expect(first.detail).toContain('分支：feat/fast-test');
    expect(first.detail).toContain('保留已有展示逻辑');
    expect(first.detail).toContain('未提供额外交付报告');
    expect(sent.find(content => content.includes(first.id))).not.toContain('feat/fast-test');
    expect(sent.find(content => content.includes(second.id))).toContain('feat/fast-test');
    expect(stageRunner).not.toHaveBeenCalled();
    expect(model.runJson).toHaveBeenCalledTimes(2);
  });
});
