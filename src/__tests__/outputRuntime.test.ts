import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuPort } from '../feishu/port.js';
import { listOutputRecords, readOutputRecord } from '../output/records.js';
import { readOutputConfiguration, writeOutputConfiguration } from '../output/configuration.js';
import { Semaphore } from '../semaphore.js';
import type { DaemonContext } from '../daemon/context.js';
import type { CardAction } from '../feishu/card.js';
import { gateDetail, gateMaterial } from '../artifacts.js';
import { ticketDir } from '../config.js';
import { askGate } from '../run/gates.js';
import type { TicketRun } from '../run/context.js';
import { saveLastRunFor } from '../followup.js';

const agent = vi.hoisted(() => ({ runText: vi.fn() }));
vi.mock('../engine/index.js', () => ({ engineFor: vi.fn(() => agent) }));
const { execAdhoc, runFollowup } = await import('../daemon/adhoc.js');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-runtime-'));
  vi.stubEnv('PIPELINE_DATA_DIR', dir);
  vi.stubEnv('PREVIEW_BASE_URL', '');
  agent.runText.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const sent: Record<string, unknown>[] = [];
  const patched: Record<string, unknown>[] = [];
  const client = { im: { message: {
    create: async (req: Record<string, unknown>) => { sent.push(req); return { data: { message_id: `om_${sent.length}` } }; },
    patch: async (req: Record<string, unknown>) => { patched.push(req); return {}; },
  } } };
  const port = new FeishuPort(client as never, null, { appId: 'a', appSecret: 'b', chatId: 'c' });
  const project = { alias: 'demo', repo: dir, prefix: 'DEMO' };
  const ctx = { port, projects: [project], cfg: { defaultProject: 'demo', maxConcurrency: 1 }, sem: new Semaphore(1),
    log: () => {}, adhoc: [], active: new Map(), MAIN_CHAT: 'c' } as unknown as DaemonContext;
  return { port, sent, patched, project, ctx, client };
}
const response = JSON.stringify({ summary: '已确认结论', detail: '完整技术依据', risks: ['尚未验证线上环境'], actions: ['确认测试范围'], evidence: ['实际检查'] });
const result = (text = response) => ({ text, turns: 1, costUsd: 0, isError: false, sessionId: 'session' });
const content = (sent: Record<string, unknown>) => (sent.data as { content: string }).content;
const action = (card: string): CardAction => JSON.parse(card).elements.flatMap((e: { actions?: Array<{ value: CardAction }> }) => e.actions ?? []).find((b: { value: CardAction }) => b.value.kind === 'output').value;
function select(level: 'concise' | 'professional') {
  const config = readOutputConfiguration();
  writeOutputConfiguration(config.revision, { ...config, defaultLevel: level });
}

describe('真实输出发送与展示', () => {
  it('配置影响真实发送；一轮只调用一次模型，简洁保留风险和下一步', async () => {
    const { ctx, project, sent } = setup();
    agent.runText.mockResolvedValue(result());
    await execAdhoc(ctx, project, '查询情况', '查询情况', [], 0, { chat: 'c' });
    expect(content(sent[0])).toContain('已确认结论');
    expect(content(sent[0])).toContain('尚未验证线上环境');
    expect(content(sent[0])).toContain('确认测试范围');
    expect(content(sent[0])).not.toContain('完整技术依据');
    select('professional');
    await execAdhoc(ctx, project, '再次查询', '再次查询', [], 0, { chat: 'c' });
    expect(content(sent[1])).toContain('完整技术依据');
    expect(agent.runText).toHaveBeenCalledTimes(2);
    expect(agent.runText.mock.calls[0][0].prompt).toContain('同时生成简洁摘要与完整说明');
  });

  it('开始冻结策略，下一轮热生效，当次明确要求覆盖设置', async () => {
    const { ctx, project, sent } = setup();
    agent.runText.mockImplementationOnce(async () => { select('professional'); return result(); }).mockResolvedValue(result());
    await execAdhoc(ctx, project, '查询情况', '查询情况', [], 0, { chat: 'c' });
    expect(content(sent[0])).not.toContain('完整技术依据');
    expect(listOutputRecords()[0]).toMatchObject({ level: 'concise', configRevision: 0 });
    await execAdhoc(ctx, project, '给开发看，查询情况', '查询情况', [], 0, { chat: 'c' });
    expect(content(sent[1])).toContain('完整技术依据');
    await execAdhoc(ctx, project, '简单说，查询情况', '查询情况', [], 0, { chat: 'c' });
    expect(content(sent[2])).not.toContain('完整技术依据');
  });

  it('无效结构输出保留原文并明确没有摘要', async () => {
    const { ctx, project, sent } = setup();
    agent.runText.mockResolvedValue(result('旧格式原始结果，不猜测摘要'));
    await execAdhoc(ctx, project, '查询情况', '查询情况', [], 0, { chat: 'c' });
    expect(content(sent[0])).toContain('未提供结构化摘要');
    expect(content(sent[0])).toContain('旧格式原始结果');
    expect(listOutputRecords()[0].summary).toBe('');
  });

  it('重启后按钮只读记录，校验原群原消息；文字展开不重跑模型', async () => {
    const { ctx, project, sent, patched } = setup();
    agent.runText.mockResolvedValue(result());
    await execAdhoc(ctx, project, '查询情况', '查询情况', [], 0, { chat: 'c' });
    const value = action(content(sent[0]));
    const restarted = setup().port;
    expect(restarted.handleCardAction(value, undefined, 'person', { chatId: 'other', messageId: 'om_1' })).toBe('denied');
    expect(restarted.handleCardAction(value, undefined, 'person', { chatId: 'c', messageId: 'wrong' })).toBe('denied');
    expect(JSON.stringify(restarted.handleCardAction(value, undefined, 'person', { chatId: 'c', messageId: 'om_1' }))).toContain('完整技术依据');
    await runFollowup(ctx, '展开依据', 'c');
    expect(patched).toHaveLength(1);
    expect(agent.runText).toHaveBeenCalledTimes(1);
    expect(readOutputRecord(value.key)?.level).toBe('concise');
  });

  it('同群其他话题不能借文字展开当前话题的结果', async () => {
    const { port, sent } = setup();
    await port.sendOutput({ stage: 'answer', title: '话题材料', summary: '摘要', detail: '仅此话题详情', risks: [], actions: [], evidence: [] }, 'c');
    const record = listOutputRecords()[0];
    expect(await port.showOutput(record.id, 'professional', { chatId: 'c', rootId: 'other-thread' })).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('主群结果本身开话题后可以展开，但其他话题和群不能借此访问', async () => {
    const { ctx, project, port, patched } = setup();
    agent.runText.mockResolvedValue(result());
    await execAdhoc(ctx, project, '查询情况', '查询情况', [], 0, { chat: 'c' });
    const record = listOutputRecords()[0];
    expect(record.rootId).toBeUndefined();
    await runFollowup(ctx, '展开依据', { chatId: 'c', rootId: record.messageId });
    expect(patched).toHaveLength(1);
    expect(agent.runText).toHaveBeenCalledTimes(1);
    expect(await port.showOutput(record.id, 'professional', { chatId: 'c', rootId: 'unrelated' })).toBe(false);
    expect(await port.showOutput(record.id, 'professional', { chatId: 'other', rootId: record.messageId })).toBe(false);
    expect(patched).toHaveLength(1);
  });

  it('展示指令找不到本话题记录时明确提示，有效旧会话也不调用模型', async () => {
    const { ctx, sent } = setup();
    saveLastRunFor('c', { at: new Date().toISOString(), project: 'demo', command: '旧会话', output: '旧版结果', chain: 0, sessionId: 'valid-session' });
    agent.runText.mockResolvedValue(result());
    await runFollowup(ctx, '展开依据', 'c');
    expect(sent.some(req => content(req).includes('没有找到本话题可展开的已保存结果'))).toBe(true);
    expect(agent.runText).not.toHaveBeenCalled();
    await runFollowup(ctx, '展开依据', { chatId: 'c', rootId: 'unrelated-thread' });
    expect(agent.runText).not.toHaveBeenCalled();
  });

  it('按钮展开先等待续卡成功；续卡失败不替换原卡，不会丢原风险', async () => {
    const { port, client, sent, patched } = setup();
    await port.sendOutput({ stage: 'answer', title: '有风险的结果', summary: '简洁结论', detail: '完整技术材料'.repeat(1000), risks: ['原卡的重要风险'], actions: [], evidence: [] }, 'c');
    const original = content(sent[0]);
    expect(original).toContain('原卡的重要风险');
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(client.im.message, 'create').mockImplementationOnce(async () => { await blocked; throw new Error('续卡网络失败'); });
    const pending = port.handleCardAction(action(original), undefined, 'person', { chatId: 'c', messageId: 'om_1' });
    expect(pending).toBeInstanceOf(Promise);
    expect(patched).toHaveLength(0);
    release();
    expect(await pending).toBe('failed');
    expect(patched).toHaveLength(0);
    expect(content(sent[0])).toBe(original);
    expect(port.pendingLabels()).toEqual([]);
    expect(agent.runText).not.toHaveBeenCalled();
  });

  it('文字展开续卡失败或首卡更新失败均明确告知且不重跑模型', async () => {
    const { ctx, project, client, sent, patched } = setup();
    agent.runText.mockResolvedValue(result(JSON.stringify({ summary: '摘要', detail: '完整技术材料'.repeat(1000), risks: ['重要风险'], actions: [], evidence: [] })));
    await execAdhoc(ctx, project, '查询情况', '查询情况', [], 0, { chat: 'c' });
    vi.spyOn(client.im.message, 'create').mockRejectedValueOnce(new Error('续卡失败'));
    await runFollowup(ctx, '展开依据', 'c');
    expect(patched).toHaveLength(0);
    expect(sent.some(req => content(req).includes('展开失败'))).toBe(true);
    expect(agent.runText).toHaveBeenCalledTimes(1);
    vi.spyOn(client.im.message, 'patch').mockRejectedValueOnce(new Error('原位更新失败'));
    await runFollowup(ctx, '展开依据', 'c');
    expect(sent.filter(req => content(req).includes('展开失败'))).toHaveLength(2);
    expect(agent.runText).toHaveBeenCalledTimes(1);
  });

  it('确认卡风险/批准后动作始终可见；独立材料切换不消费审批', async () => {
    const { port, sent } = setup();
    const decision = port.confirmGate('T-1', 'plan-approval', '请决定是否继续', ['会改变数据'], '详细材料', { materialRevision: 3, actions: ['批准后执行迁移'] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(2);
    expect(content(sent[0])).toContain('会改变数据');
    expect(content(sent[0])).toContain('批准后执行迁移');
    expect(content(sent[0])).not.toContain('详细材料');
    const view = action(content(sent[1]));
    expect(JSON.stringify(port.handleCardAction(view, undefined, 'person', { chatId: 'c', messageId: 'om_2' }))).toContain('详细材料');
    expect(port.pendingLabels('T-1')).toEqual(['plan-approval']);
    const gate = JSON.parse(content(sent[0])).elements.flatMap((e: { actions?: Array<{ value: CardAction }> }) => e.actions ?? [])[0].value;
    const record = listOutputRecords().find(r => r.sourceRef === 'T-1')!;
    expect(port.handleCardAction({ kind: 'output', key: record.id, level: 'professional' }, undefined, 'person', { chatId: 'c', messageId: 'om_1' })).toBe('denied');
    port.handleCardAction(gate, { note: '批准原第三版' });
    expect(await decision).toMatchObject({ approved: true, note: '批准原第三版' });
    expect(agent.runText).not.toHaveBeenCalled();
  });

  it('配置网页地址仍给业务用户独立材料卡，完整材料过长时随卡上传全文', async () => {
    vi.stubEnv('PREVIEW_BASE_URL', 'https://console.example');
    const { port, sent } = setup();
    const full = `全文起点${'x'.repeat(19000)}全文终点`;
    const uploaded: string[] = [];
    port.sendFiles = async (_ticket, files) => { uploaded.push(fs.readFileSync(files[0], 'utf8')); return { sent: files, failed: [] }; };
    const waiting = port.confirmGate('T-2', 'prd-confirm', '请决定', [], '卡片摘要', { fullDetail: full });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(2);
    expect(content(sent[0])).toContain('查看完整材料');
    expect(content(sent[0])).not.toContain('第 ');
    expect(content(sent[1])).toContain('另附 Markdown 文件');
    expect(uploaded).toEqual([full]);
    const record = listOutputRecords().find(r => r.sourceRef === 'T-2')!;
    expect(record.detail).toBe(full);
    port.dropPending('T-2');
    expect(await waiting).toMatchObject({ dropped: true });
  });

  it('审批快照保留完整工件，重发审批不读取已经改动的材料', async () => {
    const dirForTicket = ticketDir(dir, 'T-3');
    fs.mkdirSync(dirForTicket, { recursive: true });
    const original = `# PRD\n${'原始说明'.repeat(1000)}\n原版末尾`;
    fs.writeFileSync(path.join(dirForTicket, '10-prd.md'), original);
    expect(gateMaterial('prd-confirm', dir, 'T-3')).toBe(original);
    expect(gateDetail('prd-confirm', dir, 'T-3')).not.toContain('原版末尾');
    const gate = { gate: 'prd-confirm' as const, summary: '决定', concerns: [], stage: 'clarify' as const };
    const confirm = vi.fn(async () => ({ approved: true }));
    const run = { repo: dir, ticket: 'T-3', port: { confirmGate: confirm }, state: { pendingGate: gate }, save: vi.fn() } as unknown as TicketRun;
    await askGate(run, gate);
    const saved = vi.mocked(run.save).mock.calls.length;
    expect(saved).toBeGreaterThan(0);
    const frozen = { ...gate, outputDetail: original, outputResolution: { level: 'concise' as const, source: 'global.default', revision: 0 } };
    fs.writeFileSync(path.join(dirForTicket, '10-prd.md'), '新版材料');
    await askGate(run, frozen);
    expect((confirm.mock.calls[1] as unknown as unknown[])[5]).toMatchObject({ fullDetail: original });
    expect(agent.runText).not.toHaveBeenCalled();
  });

  it('按最终JSON字节分卡，长中文风险与待办完整保留', async () => {
    const { port, sent } = setup();
    const risk = '必须检查数据一致性。'.repeat(3000);
    const next = '确认迁移窗口。'.repeat(1000);
    await port.sendOutput({ stage: 'answer', title: '长结果', summary: '摘要', detail: '依据', risks: [risk], actions: [next], evidence: [] }, 'c');
    expect(sent.length).toBeGreaterThan(1);
    for (const request of sent) expect(Buffer.byteLength(content(request))).toBeLessThan(30000);
    const bodies = sent.map(req => JSON.parse(content(req)).elements[0].text.content).join('');
    expect(bodies).toContain(risk);
    expect(bodies).toContain(next);
    sent.length = 0;
    select('professional');
    const pending = port.confirmGate('T-4', 'plan-approval', '确认决定', [risk], '详细依据'.repeat(800));
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const request of sent) expect(Buffer.byteLength(content(request))).toBeLessThan(30000);
    port.dropPending('T-4');
    await pending;
  });
});
