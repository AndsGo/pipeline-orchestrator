import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeFollowupPrompt,
  composeRequirementDraftPrompt,
  describeLastRun,
  FOLLOWUP_TTL_MS,
  intakeContextFromLastRun,
  isDraftFromChatRequest,
  lastRunFileFor,
  readLastRun,
  readLastRunFor,
  rememberRunCard,
  runByCard,
  saveLastRun,
  saveLastRunFor,
  withRound,
  type LastRun,
} from '../followup.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-'));
  file = path.join(dir, 'last-run.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mkRun(over: Partial<LastRun> = {}): LastRun {
  return {
    at: new Date().toISOString(),
    project: 'lakeghost',
    command: '合并 LS-009 到 master',
    output: '已合并。还有两件事需要你确认：\n1. 是否 push 到远程\n2. 未跟踪目录 do 怎么处理',
    chain: 0,
    ...over,
  };
}

describe('saveLastRun / readLastRun', () => {
  it('落盘后能原样读回（含 sessionId 与 origin）', () => {
    const r = mkRun({ sessionId: '7b3a7900-16b4-44e9-817f-2f471f56d73d', origin: '评估文档' });
    saveLastRun(r, file);
    expect(readLastRun(Date.now(), file)).toEqual(r);
  });

  it('旧格式指针（无 sessionId/origin）仍可读——升级后不作废已有续聊链', () => {
    const legacy = mkRun();
    saveLastRun(legacy, file);
    const r = readLastRun(Date.now(), file);
    expect(r?.command).toBe(legacy.command);
    expect(r?.sessionId).toBeUndefined();
  });

  it('无记录返回 null，不抛', () => {
    expect(readLastRun(Date.now(), file)).toBeNull();
  });

  it('文件损坏返回 null，不抛', () => {
    fs.writeFileSync(file, '{oops', 'utf-8');
    expect(readLastRun(Date.now(), file)).toBeNull();
  });

  it('超过 TTL 视同无记录——隔天回「1」大概率不是在回上次的问题；显式 /re 可放宽 TTL 读到过期指针再问人', () => {
    const at = new Date().toISOString();
    saveLastRun(mkRun({ at }), file);
    expect(readLastRun(Date.parse(at) + FOLLOWUP_TTL_MS + 1, file)).toBeNull();
    expect(readLastRun(Date.parse(at) + FOLLOWUP_TTL_MS - 1, file)).not.toBeNull();
    expect(readLastRun(Date.parse(at) + 3 * FOLLOWUP_TTL_MS, file, Number.POSITIVE_INFINITY)?.command).toBe('合并 LS-009 到 master');
  });
});

describe('composeFollowupPrompt', () => {
  it('拼入原始任务、上次输出与本次答复', () => {
    const p = composeFollowupPrompt(mkRun(), '1 要 push；2 目录删掉');
    expect(p).toContain('合并 LS-009 到 master');
    expect(p).toContain('是否 push 到远程');
    expect(p).toContain('1 要 push；2 目录删掉');
  });

  it('续轮降级时原始任务不丢失（信息损失回归：第 2 轮起原任务曾从提示词里消失）', () => {
    const p = composeFollowupPrompt(mkRun({ command: '1.C 2.A 3.C 4.B', origin: '评估一下这份文档里的想法' }), '落盘吧');
    expect(p).toContain('评估一下这份文档里的想法'); // 原始任务
    expect(p).toContain('## 上一轮的用户答复');
    expect(p).toContain('1.C 2.A 3.C 4.B');
    expect(p).toContain('落盘吧');
  });

  it('首轮续聊（origin 与 command 相同）不重复渲染上一轮答复段', () => {
    const p = composeFollowupPrompt(mkRun({ origin: '合并 LS-009 到 master' }), '要 push');
    expect(p).not.toContain('## 上一轮的用户答复');
  });

  it('超长输出截头保尾——收尾问题在末尾', () => {
    const tail = '结尾问题：是否 push？';
    const r = mkRun({ output: 'x'.repeat(30_000) + tail });
    const p = composeFollowupPrompt(r, '要');
    expect(p).toContain('已截断');
    expect(p).toContain(tail);
    expect(p.length).toBeLessThan(25_000);
  });
});

describe('intakeContextFromLastRun（LS-013 教训：排查结论留在续聊里，工单只带走一句话）', () => {
  it('同项目、未过期 → 生成含指令与完整输出的附录，并声明相关性由澄清自行判断', () => {
    const s = intakeContextFromLastRun(mkRun(), 'lakeghost')!;
    expect(s).toContain('合并 LS-009 到 master');
    expect(s).toContain('是否 push 到远程');
    expect(s).toContain('无关请忽略');
  });

  it('无指针 / 项目不同 → null（别把 A 项目的排查贴进 B 项目的工单）', () => {
    expect(intakeContextFromLastRun(null, 'lakeghost')).toBeNull();
    expect(intakeContextFromLastRun(mkRun({ project: 'other' }), 'lakeghost')).toBeNull();
  });

  it('超长输出截断并注明留痕位置', () => {
    const s = intakeContextFromLastRun(mkRun({ output: 'x'.repeat(30_000) }), 'lakeghost')!;
    expect(s).toContain('已截断');
    expect(s.length).toBeLessThan(25_000);
  });
});

describe('整段对话累积（聊完即建单，2026-09-02）', () => {
  const r1 = { command: '排查 X 为什么慢', output: '慢在 Y 表全表扫描。1. 加索引还是改查询？' };
  const r2 = { command: '1 加索引', output: '建议对 Y.created_at 加索引；影响 3 个查询。要不要连同 Z 一起做？' };
  const r3 = { command: 'Z 先不做', output: '好，范围只含 Y 索引。' };

  it('withRound：首轮只有自己；续轮接在上一指针的整段之后；旧指针无 transcript 时由其 command/output 补出首轮', () => {
    expect(withRound(null, r1)).toEqual([r1]);
    const legacy = mkRun({ command: r1.command, output: r1.output }); // 升级前落盘的指针
    expect(withRound(legacy, r2)).toEqual([r1, r2]);
    expect(withRound(mkRun({ transcript: [r1, r2] }), r3)).toEqual([r1, r2, r3]);
  });

  it('建单附录带全部轮次，不再只有最后一轮（中间轮次的结论以前会丢）', () => {
    const s = intakeContextFromLastRun(mkRun({ chain: 2, transcript: [r1, r2, r3] }), 'lakeghost')!;
    expect(s).toContain('共 3 轮');
    expect(s).toContain('全表扫描');
    expect(s).toContain('created_at 加索引');
    expect(s).toContain('范围只含 Y 索引');
    expect(s.indexOf('第 1 轮')).toBeLessThan(s.indexOf('第 3 轮'));
  });

  it('预算从最新一轮往前分：超预算时老轮次只留用户原话，最新一轮完整保留', () => {
    const big = { command: '首轮指令', output: 'x'.repeat(19_000) };
    const s = intakeContextFromLastRun(mkRun({ transcript: [big, { command: '答复', output: 'y'.repeat(5_000) }] }), 'lakeghost')!;
    expect(s).toContain('首轮指令');
    expect(s).toContain('y'.repeat(5_000));
    expect(s).toContain('已截断');
    expect(s.length).toBeLessThan(25_000);
  });

  it('草拟提示词：含全部轮次，只要正文、范围外不扩、未定论列待确认', () => {
    const p = composeRequirementDraftPrompt(mkRun({ transcript: [r1, r2, r3] }));
    expect(p).toContain('排查 X 为什么慢');
    expect(p).toContain('范围只含 Y 索引');
    expect(p).toContain('只输出需求正文本身');
    expect(p).toContain('待确认');
    expect(p).toContain('不要擅自扩大范围');
  });

  it('isDraftFromChatRequest：空正文或「按刚才聊的建单」→ 按对话草拟；正常需求句不误判', () => {
    expect(isDraftFromChatRequest('')).toBe(true);
    expect(isDraftFromChatRequest('   ')).toBe(true);
    expect(isDraftFromChatRequest('按刚才聊的建单')).toBe(true);
    expect(isDraftFromChatRequest('把上面讨论的结论开一个工单')).toBe(true);
    expect(isDraftFromChatRequest('给 /mcp 端点加限流')).toBe(false);
    expect(isDraftFromChatRequest('对话框上面的按钮要加一个导出功能，导出为 CSV')).toBe(false); // 含「对话」「上面」但是正常需求
  });
});

describe('结果卡 ↔ 会话映射与按群指针（2026-09-04：引用 lakeghost 的卡却续到了 odoo-product 的会话）', () => {
  it('rememberRunCard / runByCard：按 message_id 精确找回那次会话；不存在 → null；输出裁到上限、不存整段 transcript', () => {
    const f = path.join(dir, 'run-sessions.json');
    const r = mkRun({ sessionId: 'sess-lake', project: 'lakeghost', output: 'x'.repeat(20_000), transcript: [{ command: 'a', output: 'b' }] });
    rememberRunCard('om_card1', r, f);
    const got = runByCard('om_card1', f)!;
    expect(got.sessionId).toBe('sess-lake');
    expect(got.project).toBe('lakeghost');
    expect(got.output.length).toBe(8000);
    expect(got.transcript).toBeUndefined();
    expect(runByCard('om_nope', f)).toBeNull();
    expect(runByCard(undefined, f)).toBeNull();
  });

  it('修剪：过期条目删掉，超量按时间保留最新的', () => {
    const f = path.join(dir, 'run-sessions.json');
    const now = Date.now();
    rememberRunCard('old', mkRun({ at: new Date(now - 61 * 24 * 3600_000).toISOString() }), f, now);
    rememberRunCard('new', mkRun({ at: new Date(now).toISOString() }), f, now);
    expect(runByCard('old', f)).toBeNull();
    expect(runByCard('new', f)).not.toBeNull();
  });

  it('按群指针：本群有就用本群的，没有退回全局', () => {
    const chat = 'oc_test_chat';
    process.env.PIPELINE_DATA_DIR = dir;
    try {
      saveLastRunFor(undefined, mkRun({ project: 'odoo-product', command: '全局那次' }));
      expect(readLastRunFor(chat)?.command).toBe('全局那次');
      saveLastRunFor(chat, mkRun({ project: 'lakeghost', command: '本群那次' }));
      expect(readLastRunFor(chat)?.command).toBe('本群那次');
      expect(readLastRunFor('oc_other')?.command).toBe('本群那次'); // 全局指针也被最新一次刷新
      expect(fs.existsSync(lastRunFileFor(chat))).toBe(true);
    } finally {
      delete process.env.PIPELINE_DATA_DIR;
    }
  });
});

describe('describeLastRun', () => {
  it('首轮：指令摘要 + 相对时间', () => {
    const at = new Date().toISOString();
    const s = describeLastRun(mkRun({ at }), Date.parse(at) + 5 * 60_000);
    expect(s).toContain('合并 LS-009 到 master');
    expect(s).toContain('5 分钟前');
    expect(s).not.toContain('续聊');
  });

  it('续轮标出轮次，超过一小时按小时说', () => {
    const at = new Date().toISOString();
    const s = describeLastRun(mkRun({ at, chain: 2 }), Date.parse(at) + 3 * 3_600_000);
    expect(s).not.toContain('续聊第'); // 2026-09-11：机制细节不给人看
    expect(s).toContain('3 小时前');
  });
});

describe('stripQuote / describeLastRun（2026-09-11 确认卡不可读）', () => {
  it('复述只留人说的话，不带引用附件，也不带「第 N 轮」', async () => {
    const { describeLastRun, stripQuote } = await import('../followup.js');
    expect(stripQuote('这个表格里面的\n\n【用户引用的消息】\n[文件已保存：D:/x]')).toBe('这个表格里面的');
    const s = describeLastRun({ at: new Date(Date.now() - 3 * 60_000).toISOString(), project: 'p', command: '这个表格里面的\n\n【用户引用的消息】\n[文件]', output: 'o', chain: 17 }, Date.now());
    expect(s).toBe('《这个表格里面的》（3 分钟前）');
  });
});
