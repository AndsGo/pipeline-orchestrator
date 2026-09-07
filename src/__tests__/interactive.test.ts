import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  asksToCreateTicket,
  buildClassifyPrompt,
  DRAFT_FROM_CHAT,
  describeCommand,
  helpText,
  isProjectSlashCommand,
  looksLikeCommand,
  looksLikeDefectReport,
  looksLikeTicket,
  nearestSlash,
  needsConfirm,
  normalize,
  parseSlash,
  slashSanityIssue,
  TICKET_RE,
} from '../commands.js';
import { appendEvent, listTickets, readEvents, timeline, totalCost } from '../events.js';
import { appendFeedback, appendRequirementAmendment, feedbackRelPath } from '../feedback.js';
import { GATE_SOURCE } from '../machine.js';
import { Semaphore } from '../semaphore.js';

const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-'));
const TICKET = 'EVT-TEST';
afterAll(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  for (const f of ['.events.jsonl']) fs.rmSync(path.resolve('data', TICKET + f), { force: true });
});

describe('事件日志（节点级记录）', () => {
  it('追加 → 读取 → 时间线渲染 → 成本累加', () => {
    appendEvent({ ticket: TICKET, type: 'ticket.created', summary: '建单' });
    appendEvent({ ticket: TICKET, type: 'stage.end', stage: 'plan', summary: 'plan → DONE', payload: { costUsd: 1.5 } });
    appendEvent({ ticket: TICKET, type: 'gate.answered', stage: 'plan', summary: '卡点通过' });
    const evs = readEvents(TICKET);
    expect(evs.map((e) => e.type)).toEqual(['ticket.created', 'stage.end', 'gate.answered']);
    expect(evs[0].ts).toMatch(/^\d{4}-/);
    const tl = timeline(TICKET);
    expect(tl).toContain('建单');
    expect(tl).toContain('卡点通过');
    expect(totalCost(TICKET)).toBeCloseTo(1.5);
  });

  it('未知工单返回空与占位文案', () => {
    expect(readEvents('NOPE-999')).toEqual([]);
    expect(timeline('NOPE-999')).toContain('暂无');
  });

  it('工单枚举排除基础设施文件（bitable-index.json 混进 /list 的回归）', () => {
    const dir = path.resolve('data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bitable-index.json'), JSON.stringify({ tickets: {}, nodes: {} }), 'utf-8');
    fs.writeFileSync(path.join(dir, 'LIST-TEST.json'), JSON.stringify({ ticket: 'LIST-TEST', cursor: 'plan' }), 'utf-8');
    try {
      const list = listTickets();
      expect(list).toContain('LIST-TEST'); // 有 ticket+cursor 自证字段的才是工单
      expect(list).not.toContain('bitable-index');
      expect(list).not.toContain('daemon');
    } finally {
      fs.rmSync(path.join(dir, 'LIST-TEST.json'), { force: true });
    }
  });
});

describe('人工反馈落盘', () => {
  const t = 'FB-1';
  it('appendFeedback 建文件、写约束说明、返回相对路径，多次追加不覆盖', () => {
    const rel = appendFeedback(tmpRepo, t, 'plan-approval 驳回', '计划漏了限流');
    expect(rel).toBe(feedbackRelPath(t));
    appendFeedback(tmpRepo, t, '群内补充说明', '顺便把超时也调小');
    const body = fs.readFileSync(path.join(tmpRepo, 'docs/pipeline', t, 'feedback.md'), 'utf-8');
    expect(body).toContain('具有约束力的人工指令');
    expect(body).toContain('计划漏了限流');
    expect(body).toContain('顺便把超时也调小');
    expect((body.match(/^## \[/gm) ?? []).length).toBe(2);
  });

  it('需求变更追加进 00-intake.md 并标注优先级与轮次', () => {
    const dir = path.join(tmpRepo, 'docs/pipeline', t);
    fs.writeFileSync(path.join(dir, '00-intake.md'), '# 原始需求\n\n> 旧需求\n', 'utf-8');
    appendRequirementAmendment(tmpRepo, t, '改成只对 /mcp 限流');
    appendRequirementAmendment(tmpRepo, t, '再加一条：超时降到 60s');
    const body = fs.readFileSync(path.join(dir, '00-intake.md'), 'utf-8');
    expect(body).toContain('## 需求变更（第 1 次');
    expect(body).toContain('## 需求变更（第 2 次');
    expect(body).toContain('以本节为准');
  });

  it('intake 不存在时明确报错，不静默创建', () => {
    expect(() => appendRequirementAmendment(tmpRepo, 'NOPE', 'x')).toThrow('不存在');
  });
});

describe('卡点驳回的回退目标', () => {
  it('PRD 驳回回澄清、计划驳回回计划、上线驳回=不发布（挂起）', () => {
    expect(GATE_SOURCE['prd-confirm']).toBe('clarify');
    expect(GATE_SOURCE['plan-approval']).toBe('plan');
    expect(GATE_SOURCE['deploy-approval']).toBe('halt');
  });
});

describe('指令解析', () => {
  it('斜杠命令：status/pause/resume/note/amend/rewind/new/list/help', () => {
    expect(parseSlash('/status LS-003')).toEqual({ kind: 'status', ticket: 'LS-003' });
    expect(parseSlash('/pause LS-003')).toEqual({ kind: 'pause', ticket: 'LS-003' });
    expect(parseSlash('/resume LS-003')).toEqual({ kind: 'resume', ticket: 'LS-003' });
    expect(parseSlash('/note LS-003 记一笔')).toEqual({ kind: 'note', ticket: 'LS-003', text: '记一笔' });
    expect(parseSlash('/amend LS-003 需求改成 X')).toEqual({ kind: 'amend', ticket: 'LS-003', text: '需求改成 X' });
    expect(parseSlash('/rewind LS-003 plan 计划不对')).toEqual({
      kind: 'rewind',
      ticket: 'LS-003',
      stage: 'plan',
      reason: '计划不对',
    });
    expect(parseSlash('/new LS-9 给 /mcp 加限流')).toEqual({ kind: 'new', ticket: 'LS-9', requirement: '给 /mcp 加限流' });
    // 不带正文也是合法 new：daemon 据此走「按刚才 /run 对话草拟需求」的零输入建单
    expect(parseSlash('/new')).toEqual({ kind: 'new', requirement: '' });
    expect(parseSlash('/list')).toEqual({ kind: 'list' });
    expect(parseSlash('/help')).toEqual({ kind: 'help' });
  });

  it('照抄的尖括号被剥掉（真机：/new <LS-004> <需求> 会建出非法工单号）', () => {
    expect(parseSlash('/new <LS-004> <给 /mcp 加限流>')).toEqual({
      kind: 'new',
      ticket: 'LS-004',
      repo: undefined,
      requirement: '给 /mcp 加限流',
    });
    expect(parseSlash('/status 「LS-004」')).toEqual({ kind: 'status', ticket: 'LS-004' });
    expect(parseSlash('/pause <LS-004>')).toEqual({ kind: 'pause', ticket: 'LS-004' });
  });

  it('/addproject：三个必填位置参数 + 任意顺序的 key=value 可选项（群内接入项目，2026-08-31）', () => {
    expect(parseSlash('/addproject nova D:/work/nova NV gitlab=组/nova jenkins=nova-job wiki=TOKEN123')).toEqual({
      kind: 'addproject',
      alias: 'nova',
      repo: 'D:/work/nova',
      prefix: 'NV',
      gitlab: '组/nova',
      jenkins: 'nova-job',
      wiki: 'TOKEN123',
    });
    expect(parseSlash('/add-project foo D:/work/foo FO')).toMatchObject({ kind: 'addproject', gitlab: undefined });
    expect(parseSlash('/addproject foo D:/work/foo')).toMatchObject({ kind: 'unknown' }); // 缺前缀
    expect(helpText()).toContain('/addproject'); // 「可以在对话中添加吗」被判成 help——帮助里必须有答案
  });

  it('斜杠命令拼错给最接近候选（/dashborad 实测，2026-09-01）', () => {
    expect(nearestSlash('dashborad')).toBe('dashboard');
    expect(nearestSlash('reusme')).toBe('resume');
    expect(nearestSlash('dashboard')).toBeNull(); // 拼对了不提示（不该走到这）
    expect(nearestSlash('xyzabc')).toBeNull(); // 差太远不硬猜
  });

  it('/use 与 /bind：项目粘性与群绑定（2026-08-31 单群多项目的上下文切换之痛）', () => {
    expect(parseSlash('/use nova')).toEqual({ kind: 'use', alias: 'nova' });
    expect(parseSlash('/use')).toEqual({ kind: 'use', alias: undefined });
    expect(parseSlash('/bind odoo-product')).toEqual({ kind: 'bind', alias: 'odoo-product' });
    expect(parseSlash('/bind')).toMatchObject({ kind: 'unknown' }); // 绑定必须指名项目
    expect(helpText()).toContain('/use');
    expect(helpText()).toContain('/bind');
  });

  it('/new 首段不像工单号时整句当需求，工单号交给自动编号', () => {
    const c = parseSlash('/new MCP 调用方式需要调整，改用 SSE');
    expect(c).toMatchObject({ kind: 'new', ticket: undefined });
    expect((c as { requirement: string }).requirement).toContain('MCP 调用方式');
  });

  it('/new 能从需求里抽出「仓库<路径>」前缀', () => {
    const c = parseSlash('/new <LS-004> <仓库D:/work/lake_spirit.MCP 调用方式需要调整>') as {
      repo?: string;
      requirement: string;
    };
    expect(c.repo).toBe('D:/work/lake_spirit');
    expect(c.requirement).toBe('MCP 调用方式需要调整');
  });

  it('工单号校验拒绝非法字符（要能安全当文件名与分支名）', () => {
    for (const bad of ['<LS-004>', 'LS 004', '../etc', '4LS', '']) expect(TICKET_RE.test(bad), bad).toBe(false);
    for (const ok of ['LS-004', 'ls_4', 'Abc-123_x']) expect(TICKET_RE.test(ok), ok).toBe(true);
  });

  it('工单号识别要求含数字，避免把需求首词当工单号', () => {
    expect(looksLikeTicket('LS-004')).toBe(true);
    expect(looksLikeTicket('MCP')).toBe(false); // 纯字母是需求的第一个词
    expect(looksLikeTicket('需求')).toBe(false);
  });

  it('帮助文本不含 <占位符>（否则用户会照抄）', () => {
    expect(helpText()).not.toMatch(/<[^>]*工单号[^>]*>/);
    expect(helpText()).toContain('LS-004');
  });

  it('非法/缺参数的斜杠命令归为 unknown，绝不猜测执行', () => {
    expect(parseSlash('/rewind LS-003 nosuchstage')).toMatchObject({ kind: 'unknown' });
    expect(parseSlash('/amend LS-003')).toMatchObject({ kind: 'unknown' });
    expect(parseSlash('/pause')).toMatchObject({ kind: 'unknown' });
    expect(parseSlash('普通聊天')).toBeNull();
  });

  it('NL 归一化：单一活跃工单时自动补 ticket；非法组合降为 unknown', () => {
    expect(normalize({ kind: 'status' }, '现在到哪了', ['LS-003'])).toEqual({ kind: 'status', ticket: 'LS-003' });
    expect(normalize({ kind: 'rewind', ticket: 'LS-003', stage: 'plan' }, 'x', [])).toMatchObject({ kind: 'rewind' });
    expect(normalize({ kind: 'rewind', ticket: 'LS-003' }, 'x', [])).toMatchObject({ kind: 'unknown' }); // 缺 stage
    expect(normalize({ kind: 'amend', ticket: 'LS-003' }, 'x', [])).toMatchObject({ kind: 'unknown' }); // 缺正文
    expect(normalize({ kind: 'pause' }, 'x', ['A', 'B'])).toMatchObject({ kind: 'unknown' }); // 多工单不猜
  });

  it('未 @ 时的关键词门槛：自然说法能过，闲聊不过（真机缺陷回归）', () => {
    for (const s of ['现在到哪了', 'LS-003 走到哪了', '这个需求改一下', '退回去重做计划', '暂停一下', '看下进度', 'status']) {
      expect(looksLikeCommand(s), s).toBe(true);
    }
    for (const s of ['今天中午吃什么', '好的收到', '哈哈哈']) {
      expect(looksLikeCommand(s), s).toBe(false);
    }
  });

  it('斜杠语义体检：验收阶段用 /amend 报缺陷会被拦下（真机事故回归）', () => {
    const ctx = { ticket: 'LS-004', stage: 'acceptance', runState: '等人工', pending: ['Q1'] };
    const bug = { kind: 'amend' as const, ticket: 'LS-004', text: '测试 /mcp/sse 异常，返回 invalid or expired token' };
    expect(slashSanityIssue(bug, ctx)).toContain('缺陷现象');
    // 真的改需求不该被拦
    const real = { kind: 'amend' as const, ticket: 'LS-004', text: '需求改成同时支持 SSE 与 WebSocket' };
    expect(slashSanityIssue(real, ctx)).toBeNull();
    // 澄清阶段本来就该改需求，不拦
    expect(slashSanityIssue(bug, { ...ctx, stage: 'clarify' })).toBeNull();
    // 其他指令不体检
    expect(slashSanityIssue({ kind: 'note', ticket: 'LS-004', text: '报错了' }, ctx)).toBeNull();
  });

  it('缺陷特征词识别覆盖中英文与状态码', () => {
    for (const s of ['接口报错', '返回 invalid token', '页面 500', '一直超时', 'malformed header', '不通过'])
      expect(looksLikeDefectReport(s), s).toBe(true);
    for (const s of ['需求改成支持 SSE', '再加一个导出功能']) expect(looksLikeDefectReport(s), s).toBe(false);
  });

  it('分级确认：改变流程走向的要确认，记录类不打扰', () => {
    expect(needsConfirm({ kind: 'amend', ticket: 'T', text: 'x' })).toBe(true);
    expect(needsConfirm({ kind: 'rewind', ticket: 'T', stage: 'plan' })).toBe(true);
    expect(needsConfirm({ kind: 'pause', ticket: 'T' })).toBe(true);
    expect(needsConfirm({ kind: 'note', ticket: 'T', text: 'x' })).toBe(false);
    expect(needsConfirm({ kind: 'status', ticket: 'T' })).toBe(false);
    expect(needsConfirm({ kind: 'answer', ticket: 'T', text: '通过' })).toBe(false);
  });

  it('确认卡片文案要说清后果，并给出"其实想报缺陷"的出口', () => {
    const d = describeCommand({ kind: 'amend', ticket: 'LS-004', text: '改成 SSE' });
    expect(d).toContain('回退到澄清阶段重跑');
    expect(d).toContain('记为说明');
    expect(describeCommand({ kind: 'rewind', ticket: 'T', stage: 'plan' })).toContain('代码提交不回滚');
  });

  it('分类提示词带上现场：阶段、状态、待答项', () => {
    const p = buildClassifyPrompt('不通过，报 500', [
      { ticket: 'LS-004', stage: 'acceptance', runState: '等人工', pending: ['Q1', 'Q3'] },
    ]);
    expect(p).toContain('LS-004');
    expect(p).toContain('acceptance');
    expect(p).toContain('正在等回答：Q1、Q3');
    expect(p).toContain('绝不是 amend'); // 缺陷≠需求变更的规则必须在提示词里
  });

  it('answer 意图归一化：缺正文降级 unknown，带 target 保留', () => {
    expect(normalize({ kind: 'answer', ticket: 'T', target: 'Q3', text: '不通过 报500' }, 'x', [])).toEqual({
      kind: 'answer',
      ticket: 'T',
      target: 'Q3',
      text: '不通过 报500',
    });
    expect(normalize({ kind: 'answer', ticket: 'T' }, 'x', [])).toMatchObject({ kind: 'unknown' });
  });

  it('/run 单次执行：三个别名都认，整句作为提示词', () => {
    expect(parseSlash('/run 这个仓库的鉴权中间件在哪')).toEqual({ kind: 'run', text: '这个仓库的鉴权中间件在哪' });
    expect(parseSlash('/ask 跑一下前端测试')).toEqual({ kind: 'run', text: '跑一下前端测试' });
    // 跑 skill：斜杠开头的内容原样透传，不被再解析一次
    expect(parseSlash('/skill /security-review')).toEqual({ kind: 'run', text: '/security-review' });
    expect(parseSlash('/run')).toMatchObject({ kind: 'unknown' });
  });

  it('/run 不需要确认，不会被误判为破坏性指令', () => {
    expect(needsConfirm({ kind: 'run', text: 'x' })).toBe(false);
  });

  // 实测踩坑：`/run 运行 /docker_push skills` 跑了 4 轮、报告正常，实际一行都没执行——
  // 斜杠指令只有独占提示词开头才会被 headless 展开，前面拼知识摘要也一样会废掉它。
  it('识别项目斜杠指令：只有独占开头才算，用来决定能不能前置知识摘要', () => {
    expect(isProjectSlashCommand('/docker-push')).toBe(true);
    expect(isProjectSlashCommand('  /security-review 一下')).toBe(true);
    expect(isProjectSlashCommand('运行 /docker-push')).toBe(false);
    expect(isProjectSlashCommand('这个仓库的 /mcp 端点怎么鉴权')).toBe(false);
    expect(isProjectSlashCommand('/')).toBe(false);
  });

  // 闸门不能只认斜杠语法：「帮我把镜像推一下」照样能拿着 Bash 把 latest 推上去
  it('分类结果带出 side_effect，用于决定要不要先确认', () => {
    expect(normalize({ kind: 'run', side_effect: true }, '把前端镜像推到仓库', [])).toEqual({
      kind: 'run',
      text: '把前端镜像推到仓库',
      sideEffect: true,
    });
    expect(normalize({ kind: 'run' }, '鉴权在哪', [])).toMatchObject({ sideEffect: false });
  });

  // 实测：haiku 把 text 填成了自己的推理（"…属于只读诊断操作"），
  // 用户的现象描述和 URL 全丢了，执行会话拿到一段判断理由当需求
  it('run 一律用用户原话，忽略分类器改写的 text', () => {
    const original = 'lakeghost 上线后 https://lakeghost.hbo-erp.com/mcp/sse?key=abc 卡住不返回';
    expect(normalize({ kind: 'run', text: 'SSE 端点问题需要诊断，属于只读操作' }, original, [])).toMatchObject({
      kind: 'run',
      text: original,
    });
  });

  // 一条生产缺陷报告因为没写工单号就被降级成 unknown、回一句"没听懂"，是最伤信任的失败方式
  it('note/amend 缺工单号时保留意图（交给人选），不静默降级成 unknown', () => {
    expect(normalize({ kind: 'note', text: 'MCP 连不上' }, '原话', ['LS-002', 'LS-005'])).toMatchObject({
      kind: 'unknown',
    });
    // normalize 仍保守返回 unknown，但 classifyCommand 会额外带出 missingTicket 供调用方发问
    expect(normalize({ kind: 'note', text: 'MCP 连不上' }, '原话', ['LS-002'])).toMatchObject({
      kind: 'note',
      ticket: 'LS-002',
    });
  });

  it('分类提示词要求：线上故障且未指明工单 → run 而不是 note', () => {
    const p = buildClassifyPrompt('生产上 MCP 连不上', []);
    expect(p).toContain('ticket 必填');
    expect(p).toContain('run（先诊断）');
  });

  it('分类提示词不再声称 run 是只读的，并要求判定 side_effect', () => {
    const p = buildClassifyPrompt('把镜像推一下', []);
    expect(p).not.toContain('run：单次执行，**只读**');
    expect(p).toContain('它有 Bash 权限，不是只读的');
    expect(p).toContain('side_effect');
    expect(p).toContain('拿不准填 true');
  });

  it('分类提示词写明 run 与 new 的分界（要改代码就建工单）', () => {
    const p = buildClassifyPrompt('这个仓库的鉴权在哪', []);
    expect(p).toContain('run：单次执行');
    expect(p).toContain('要改代码就是 new');
  });

  it('分类提示词写明带工单号的「继续」是 resume（实测「继续 LS-013」曾被判 unknown@30%，人被迫退回斜杠命令）', () => {
    const p = buildClassifyPrompt('随便一句', []);
    expect(p).toContain('resume：继续/恢复某个工单');
    expect(p).toContain('「继续 LS-013」');
    expect(p).toContain('不带工单号的「继续」');
  });

  it('帮助文本覆盖全部指令', () => {
    const h = helpText();
    for (const k of ['/new', '/status', '/pause', '/resume', '/amend', '/rewind', '/note']) expect(h).toContain(k);
  });
});

describe('并发闸门', () => {
  it('超过上限的请求排队，释放后放行', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    expect(sem.inUse).toBe(2);
    let third = false;
    const p = sem.acquire().then((rel) => {
      third = true;
      return rel;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.waiting).toBe(1);
    r1();
    await p;
    expect(third).toBe(true);
  });
});

// 2026-09-07 实测：同一话题连发三条 @ 消息（分析同步逻辑 → /re 2 → 「我觉得问题在分页，请你深入」），
// 只有打了 /re 的那条续上了会话，另两条各被判 run 开新会话重读代码（$0.45 + $1.10）。分类器根本不知道本群刚跑过什么。
describe('意图识别带上本群最近一次 /run，回应它的话判 followup 续会话', () => {
  const last = {
    at: new Date().toISOString(),
    project: 'lakeghost',
    command: '分析下现在的同步用户的逻辑',
    output: '…根因：31 名在职员工 dd_userid 为空被跳过。顺带发现本地把映射改成了 oa_userid，方向是错的。',
    chain: 0,
  };

  it('有最近执行 → 提示词含其指令、输出末尾与 followup 选项；没有 → 不给 followup 选项', () => {
    const p = buildClassifyPrompt('我不想改之前的逻辑，我觉得问题在分页，请你深入', [], last);
    expect(p).toContain('本群最近一次单次执行');
    expect(p).toContain('分析下现在的同步用户的逻辑');
    expect(p).toContain('oa_userid');
    expect(p).toContain('followup：');
    expect(p).toContain('换了话题的新问题仍是 run');
    expect(buildClassifyPrompt('鉴权在哪', [])).not.toContain('followup：');
  });

  it('followup 归一化：一律用用户原话', () => {
    expect(normalize({ kind: 'followup', text: '模型改写的话' }, '原话', [])).toEqual({ kind: 'followup', text: '原话' });
  });
});

// 2026-09-07 实测：「现在就发，两条一起写进一个工单」被判 followup@88%，/run 会话答「我没有能力直接建工单」，人只能复制粘贴 /new
describe('续聊里要求建单 → new（按对话草拟需求），不是 followup', () => {
  it('分类提示词写明例外：建成工单 → new，text 固定填草拟哨兵', () => {
    const p = buildClassifyPrompt('现在就发，两条一起写进一个工单', [], { at: new Date().toISOString(), project: 'lakeghost', command: 'x', output: 'y', chain: 2 });
    expect(p).toContain('建成工单');
    expect(p).toContain(DRAFT_FROM_CHAT);
  });
  it('词面兜底：建/开/写进工单的句子认；业务词「提单」「发单量」「工单里的字段」不认', () => {
    for (const t of ['现在就发，两条一起写进一个工单', '建个单吧', '把这两条建单', '开一张新工单', '整理成一个工单']) expect(asksToCreateTicket(t)).toBe(true);
    for (const t of ['查一下提单号的字段', '发单量为什么掉了', '工单里的字段是啥', '继续深入分析', '2']) expect(asksToCreateTicket(t)).toBe(false);
  });
});
