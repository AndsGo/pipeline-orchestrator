import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuPort } from '../feishu/port.js';
import { createReq, readReq, type RequirementCard } from '../requirements.js';
import { bindReqThread } from '../threads.js';
import { Semaphore } from '../semaphore.js';
import { createOutputRecord, listOutputRecords, readOutputRecord } from '../output/records.js';
import { readOutputConfiguration, writeOutputConfiguration, type OutputLevel, type OutputStage } from '../output/configuration.js';
import { composeOutputInstructions, parseOutputResponse } from '../output/presentation.js';
import { TicketRun } from '../run/context.js';
import { dispatchAction } from '../run/actions.js';
import { ticketDir } from '../config.js';
import type { DaemonContext } from '../daemon/context.js';
import type { TicketState } from '../types.js';

const model = vi.hoisted(() => ({ runText: vi.fn() }));
vi.mock('../engine/index.js', () => ({ engineFor: vi.fn(() => model) }));
const { execAdhoc } = await import('../daemon/adhoc.js');

let root: string;
let repo: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-stages-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('PIPELINE_DATA_DIR', path.join(root, 'data'));
  for (const key of ['BITABLE_APP_TOKEN', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'PREVIEW_BASE_URL', 'CONSOLE_BASE_URL']) vi.stubEnv(key, '');
  model.runText.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const sent: Array<{ data: { content: string } }> = [];
  const patched: Array<{ data: { content: string } }> = [];
  const post = async (req: { data: { content: string } }) => { sent.push(req); return { data: { message_id: `message-${sent.length}` } }; };
  const client = { im: { message: { create: post, reply: post, patch: async (req: { data: { content: string } }) => { patched.push(req); return {}; } } } };
  const port = new FeishuPort(client as never, null, { appId: 'test', appSecret: 'test', chatId: 'chat-a' });
  const project = { alias: 'demo', repo, prefix: 'DEMO' };
  const ctx = { port, projects: [project], cfg: { defaultProject: 'demo', maxConcurrency: 1 }, sem: new Semaphore(1),
    log: () => {}, adhoc: [], active: new Map(), MAIN_CHAT: 'chat-a' } as unknown as DaemonContext;
  return { port, project, ctx, sent, patched };
}
function select(stage: OutputStage, level: OutputLevel) {
  const config = readOutputConfiguration();
  writeOutputConfiguration(config.revision, { ...config, projects: { [repo]: { stages: { [stage]: level } } } });
}
const card: RequirementCard = { title: '取消未下发历史任务', problem: '历史任务仍在队列', expected: '停用后取消未下发任务', acceptance: '未下发任务不再执行',
  questions: ['请确认是否包含旧版本？'], facts: ['已核对队列记录'], assumptions: ['已下发任务暂不取消'], splits: [], ready: false };
const response = { summary: '可以继续排查', detail: '完整技术材料', risks: [], actions: [], evidence: [] };

describe('intake and delivery actual output paths', () => {
  it('需求话题按intake配置发送，简洁保留未确认风险和提问，材料切换不重跑模型', async () => {
    const { ctx, project, port, sent, patched } = setup();
    const req = createReq({ project: 'demo', requester: 'person-a', chatId: 'chat-a', rootId: 'thread-a', raw: '停用后清理任务' });
    bindReqThread('thread-a', req.id, 'chat-a', 'demo');
    const text = `\`\`\`requirement-card\n${JSON.stringify(card)}\n\`\`\``;
    model.runText.mockResolvedValue({ text, turns: 1, costUsd: 0, isError: false, sessionId: 'session' });
    const origin = { chatId: 'chat-a', rootId: 'thread-a' };
    await execAdhoc(ctx, project, '请整理', '请整理需求', [], 0, { chat: origin });
    const concise = listOutputRecords().find(record => record.stage === 'intake')!;
    const first = sent.find(message => message.data.content.includes(concise.id))!.data.content;
    expect(concise).toMatchObject({ level: 'concise', sourceRef: req.id, rootId: 'thread-a', materialRevision: 1 });
    expect(first).toContain(card.assumptions[0]);
    expect(first).toContain(card.questions[0]);
    expect(first).not.toContain(card.facts[0]);
    expect(readReq(req.id)?.revision).toBe(1);
    expect(await port.showOutput(concise.id, 'professional', origin)).toBe(true);
    expect(patched[0].data.content).toContain(card.facts[0]);
    expect(patched[0].data.content).toContain(card.expected);
    select('intake', 'professional');
    await execAdhoc(ctx, project, '继续整理', '请更新需求', [], 0, { chat: origin });
    const full = listOutputRecords().find(record => record.stage === 'intake' && record.level === 'professional')!;
    expect(full).toMatchObject({ levelSource: 'project.stage', configRevision: 1, materialRevision: 2 });
    expect(sent.find(message => message.data.content.includes(full.id))!.data.content).toContain(card.facts[0]);
    expect(model.runText).toHaveBeenCalledTimes(2);
  });

  it('闭环交付按delivery配置发送，风险待办始终可见且完整工件可展开', async () => {
    const { port, project, sent, patched } = setup();
    const delivery = '# 完整交付材料\n\n已完成接口核对。\n\n## 风险\n线上情况尚未核对。';
    async function close(ticket: string) {
      const folder = ticketDir(repo, ticket);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, '95-delivery.md'), delivery);
      const state: TicketState = { ticket, repo, cursor: 'compound', lane: 'full', reviewFixRounds: 0, acceptanceFixRounds: 0, pendingReverify: null, runs: [],
        postReleaseChecks: [{ id: 'AC-1', question: '请在线上核对停用后的队列', recommended: '通过', why: '需要真实环境验证' }] };
      const run = new TicketRun({ repo, ticket, port, project }, state);
      expect(await dispatchAction(run, { kind: 'done' }, { stage: 'compound', status: 'DONE', handoff_path: `docs/pipeline/${ticket}/90-retro.md`, summary_for_card: '任务清理已完成，待线上确认', concerns: ['线上情况尚未核对'] }, 'compound', null)).toBe('return');
      return listOutputRecords().find(record => record.sourceRef === ticket && record.stage === 'delivery')!;
    }
    const concise = await close('DEMO-1');
    const first = sent.find(message => message.data.content.includes(concise.id))!.data.content;
    expect(first).toContain('线上情况尚未核对');
    expect(first).toContain('请在线上核对停用后的队列');
    expect(first).not.toContain('完整交付材料');
    expect(readOutputRecord(concise.id)?.detail).toBe(delivery);
    expect(await port.showOutput(concise.id, 'professional', 'chat-a')).toBe(true);
    expect(patched[0].data.content).toContain('完整交付材料');
    select('delivery', 'professional');
    const professional = await close('DEMO-2');
    expect(professional).toMatchObject({ level: 'professional', levelSource: 'project.stage', configRevision: 1 });
    expect(sent.find(message => message.data.content.includes(professional.id))!.data.content).toContain('完整交付材料');
    expect(model.runText).not.toHaveBeenCalled();
  });
});

describe('output handoff and topic storage', () => {
  it('validates optional internal handoff while returning only business material', () => {
    expect(parseOutputResponse(JSON.stringify({ ...response, internalHandoff: 'tool=db, args=internal-only' }))).toEqual(response);
    expect(parseOutputResponse(JSON.stringify({ ...response, internalHandoff: [] }))).toBeNull();
    const prompt = composeOutputInstructions();
    expect(prompt).toContain('internalHandoff');
    expect(prompt).toContain('不以函数名、字段名或工具过程开头');
    expect(prompt).toContain('线上已验证');
  });

  it('persists and validates the exact thread binding', () => {
    const input = { stage: 'answer' as const, title: '测试', ...response };
    const record = createOutputRecord(input, { chatId: 'chat-a', rootId: 'thread-a' });
    expect(readOutputRecord(record.id)?.rootId).toBe('thread-a');
    expect(() => createOutputRecord(input, { chatId: 'chat-a', rootId: ' ' })).toThrow();
    fs.writeFileSync(path.join(root, 'data', 'outputs', `${record.id}.json`), JSON.stringify({ ...record, rootId: 42 }));
    expect(() => readOutputRecord(record.id)).toThrow('元数据');
  });
});
