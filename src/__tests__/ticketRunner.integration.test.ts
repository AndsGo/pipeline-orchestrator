import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Answer } from '../backfill.js';
import { ticketDir } from '../config.js';
import { readEvents } from '../events.js';
import type { GateDecision, InteractionPort } from '../ports.js';
import { readSnapshot, saveTicket } from '../ticket.js';
import { runTicket, type RunTicketOpts } from '../ticketRunner.js';
import type { Envelope, OpenQuestion, Stage, StageResult, TicketState } from '../types.js';

/**
 * runTicket 端到端：真 git 仓库 + 真 data 目录（临时）+ 假引擎（不起 claude）+ 脚本化端口（不连飞书）。
 * 由来：OP-002（2026-09-02）plan-approval 没人答、daemon 重启后游标已在 implement，「继续」直接跳过了审批——
 * 状态机、持久化、卡点三者的交互此前没有任何一条测试路径能覆盖，缺陷只能靠生产事故发现。
 */

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-int-data-'));
const repos: string[] = [];
const prevDataDir = process.env.PIPELINE_DATA_DIR;

beforeAll(() => {
  process.env.PIPELINE_DATA_DIR = dataRoot;
  // 任何会让 runner 去碰外部系统的开关都必须缺席：知识表/CI/飞书文档/GitLab/双评审/对照实验
  for (const k of [
    'BITABLE_APP_TOKEN',
    'BITABLE_TICKET_TABLE_ID',
    'BITABLE_NODE_TABLE_ID',
    'JENKINS_URL',
    'JENKINS_JOB',
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'GITLAB_URL',
    'GITLAB_API_TOKEN',
    'PIPELINE_DOUBLE_REVIEW',
    'PIPELINE_HINTS_OFF',
    'PIPELINE_IMPLEMENT_MODEL',
    'PREVIEW_BASE_URL',
  ]) {
    delete process.env[k];
  }
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.PIPELINE_DATA_DIR;
  else process.env.PIPELINE_DATA_DIR = prevDataDir;
  for (const d of [dataRoot, ...repos]) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- 夹具：临时 git 仓库 ----------

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-int-repo-'));
  repos.push(repo);
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
  };
  git('init -q');
  git('config user.email pipeline@test.local');
  git('config user.name pipeline-test');
  git('config commit.gpgsign false');
  fs.mkdirSync(path.join(repo, 'docs', 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'pipeline', '.gitkeep'), '', 'utf-8');
  git('add -A');
  git('commit -q -m init');
  return repo;
}

// ---------- 夹具：假引擎（代替 runStage 起 claude -p） ----------

/** 一步脚本：覆盖默认 StageResult 的字段，或让会话以 is_error 收场（result 为报错文案） */
type Step = Partial<StageResult> | { is_error: string };

const PASS_AXES: StageResult['axes'] = {
  spec: { total: 2, failed: 0, worst: null },
  quality: { critical: 0, important: 0, minor: 0, worst: null },
};

/** 各阶段 skill 正常收工时会留下的工件；引擎每次被调都写一遍，路由与卡片材料提取都读它们 */
function writeArtifacts(repo: string, ticket: string, stage: Stage, reviewRound: number): void {
  const dir = ticketDir(repo, ticket);
  fs.mkdirSync(dir, { recursive: true });
  const w = (f: string, body: string): void => fs.writeFileSync(path.join(dir, f), body, 'utf-8');
  switch (stage) {
    case 'clarify':
      w(
        '10-prd.md',
        [
          `# ${ticket} PRD`,
          '',
          '## 范围',
          '**In：**',
          '- 首页列表',
          '**Out：**',
          '- 导出',
          '',
          '## 验收标准',
          '',
          '### AC-1: 首页显示列表',
          '**验证方式：** 自动',
          '',
          '### AC-2: 空态提示',
          '**验证方式：** 人工',
          '',
          '## 本阶段结论',
          '',
          'PRD 定稿。',
          '',
        ].join('\n'),
      );
      break;
    case 'plan':
      w('20-plan.md', `# 计划\n\n## 审批摘要\n\n两个任务。\n\n### Task 1: 列表接口\n\n### Task 2: 空态\n\n## 本阶段结论\n\n计划定稿。\n`);
      break;
    case 'implement':
      w('25-impl-report.md', `# 实现报告\n\n## 本阶段结论\n\n完成。\n`);
      w('ledger.md', `# ledger\n\n- Task 1: complete\n- Task 2: complete\n`);
      break;
    case 'review':
      w(`30-review-r${reviewRound}.md`, `# 评审 r${reviewRound}\n\n## 本阶段结论\n\n见 verdict。\n`);
      break;
    case 'acceptance':
      // 第二轮验收是在人工回填过的文件上续写，不能把回填的问答冲掉
      if (!fs.existsSync(path.join(dir, '40-acceptance.md'))) {
        w('40-acceptance.md', `# 验收\n\n## 本阶段结论\n\n| AC | 结果 |\n|---|---|\n| AC-1 | 通过 |\n`);
      }
      break;
    case 'compound':
      w('90-retro.md', `# 回顾\n\n## 本阶段结论\n\n无新教训。\n`);
      w('96-knowledge.json', '[]');
      w('92-suggestions.json', JSON.stringify({ claudeMd: [], process: [] }));
      break;
    case 'ci':
      break;
  }
}

function defaultResult(ticket: string, stage: Exclude<Stage, 'ci'>, reviewRound: number): StageResult {
  const rel = (f: string): string => `docs/pipeline/${ticket}/${f}`;
  const base = { status: 'DONE' as const, summary_for_card: `${stage} 完成` };
  switch (stage) {
    case 'clarify':
      return { ...base, stage, handoff_path: rel('10-prd.md') };
    case 'plan':
      return { ...base, stage, handoff_path: rel('20-plan.md') };
    case 'implement':
      return { ...base, stage, handoff_path: rel('25-impl-report.md') };
    case 'review':
      return { ...base, stage, handoff_path: rel(`30-review-r${reviewRound}.md`), verdict: 'PASS', axes: PASS_AXES };
    case 'acceptance':
      return { ...base, stage, handoff_path: rel('40-acceptance.md'), verdict: 'PASS' };
    case 'compound':
      return { ...base, stage, handoff_path: rel('90-retro.md') };
  }
}

class FakeEngine {
  readonly calls: Array<{ stage: Stage; extraArgs: string; model?: string }> = [];
  private readonly queues = new Map<Stage, Step[]>();

  /** 为某阶段预置按序消费的脚本；用完后回到默认（DONE / PASS） */
  on(stage: Stage, ...steps: Step[]): this {
    this.queues.set(stage, [...(this.queues.get(stage) ?? []), ...steps]);
    return this;
  }

  readonly run: NonNullable<RunTicketOpts['stageRunner']> = async (repo, ticket, stage, extraArgs = '', model) => {
    this.calls.push({ stage, extraArgs, model });
    const step = this.queues.get(stage)?.shift() ?? {};
    const sessionId = `sess-${this.calls.length}`;
    if ('is_error' in step) {
      const envelope: Envelope = { is_error: true, num_turns: 1, total_cost_usd: 0.01, session_id: sessionId, permission_denials: [], result: step.is_error };
      return { envelope, rawStdout: '' };
    }
    const reviewRound = this.calls.filter((c) => c.stage === 'review').length;
    writeArtifacts(repo, ticket, stage, reviewRound);
    const structured_output: StageResult = { ...defaultResult(ticket, stage, reviewRound), ...step };
    const envelope: Envelope = { is_error: false, num_turns: 3, total_cost_usd: 0.5, session_id: sessionId, permission_denials: [], structured_output };
    return { envelope, rawStdout: '' };
  };
}

const fakePrototype: NonNullable<RunTicketOpts['prototype']> = async () => ({ ok: true, costUsd: 0.1, turns: 2 });

// ---------- 夹具：脚本化端口 ----------

type AnswerScript = ((qs: OpenQuestion[]) => Answer[]) | 'defer';

class ScriptedPort implements InteractionPort {
  readonly notifications: string[] = [];
  readonly gates: Array<{ gate: string; summary: string; concerns: string[]; detail?: string }> = [];
  readonly questions: OpenQuestion[][] = [];
  readonly reports: Array<{ title: string; markdown: string }> = [];
  /** 'defer' 脚本挂起的提问：测试稍后自己 resolve（模拟几天后才有人答的补验卡） */
  readonly deferred: Array<{ questions: OpenQuestion[]; resolve: (a: Answer[]) => void }> = [];
  private readonly gateScript: Array<GateDecision | 'hang'> = [];
  private readonly answerScript: AnswerScript[] = [];

  gate(...decisions: Array<GateDecision | 'hang'>): this {
    this.gateScript.push(...decisions);
    return this;
  }

  answers(...scripts: AnswerScript[]): this {
    this.answerScript.push(...scripts);
    return this;
  }

  async askQuestions(_ticket: string, qs: OpenQuestion[]): Promise<Answer[]> {
    this.questions.push(qs);
    const next = this.answerScript.shift();
    if (!next) throw new Error(`端口收到未预期的提问：${qs.map((q) => q.id).join(',')}`);
    if (next === 'defer') return new Promise((resolve) => this.deferred.push({ questions: qs, resolve }));
    return next(qs);
  }

  async confirmGate(_ticket: string, gate: string, summary: string, concerns: string[], detail?: string): Promise<GateDecision> {
    this.gates.push({ gate, summary, concerns, detail });
    const d = this.gateScript.shift();
    if (!d) throw new Error(`端口收到未预期的卡点：${gate}`);
    // 模拟 daemon 重启：卡发出去了，进程内再也等不到答复
    if (d === 'hang') return new Promise(() => {});
    return d;
  }

  async notify(_ticket: string, message: string): Promise<void> {
    this.notifications.push(message);
  }

  async sendReport(_ticket: string, title: string, markdown: string): Promise<void> {
    this.reports.push({ title, markdown });
  }

  close(): void {}
}

const approve: GateDecision = { approved: true };
const reject = (note: string): GateDecision => ({ approved: false, note });
const answerAll = (answer: string) => (qs: OpenQuestion[]): Answer[] => qs.map((q) => ({ id: q.id, question: q.question, answer }));

const HUMAN_Q: OpenQuestion = {
  id: 'Q1',
  question: '空态提示文案是否符合业务口径？',
  options: ['通过', '不通过', '无法验证'],
  recommended: '通过',
  why: '人工项',
};

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const snap = (ticket: string): TicketState => {
  const s = readSnapshot(ticket);
  if (!s) throw new Error(`无快照 ${ticket}`);
  return s;
};
const stages = (engine: FakeEngine): Stage[] => engine.calls.map((c) => c.stage);
const events = (ticket: string, type: string): string[] => readEvents(ticket).filter((e) => e.type === type).map((e) => e.summary);

// ---------- 场景 ----------

describe('runTicket 集成（假引擎 + 脚本化端口）', () => {
  it('a. 全流水线闭环：两次卡点、一次验收人工问答、第二轮验收定稿、compound 收尾', async () => {
    const repo = makeRepo();
    const T = 'IT-1';
    const engine = new FakeEngine().on('acceptance', { status: 'NEEDS_CONTEXT', verdict: null, open_questions: [HUMAN_Q] }, {});
    const port = new ScriptedPort().gate(approve, approve).answers(answerAll('通过'));

    await runTicket({ repo, ticket: T, port, lane: 'full', requirement: '首页加列表', stageRunner: engine.run, prototype: fakePrototype });

    expect(stages(engine)).toEqual(['clarify', 'plan', 'implement', 'review', 'acceptance', 'acceptance', 'compound']);
    expect(engine.calls[3].extraArgs).toMatch(/^base=[0-9a-f]{40}$/); // review 以首次 implement 前的 HEAD 为 diff 基点
    expect(port.gates.map((g) => g.gate)).toEqual(['prd-confirm', 'plan-approval']);
    expect(port.gates[0].summary).toContain('结果预览已生成'); // 原型随 PRD 确认卡一起发
    expect(port.gates[0].detail).toContain('AC-1'); // 卡片带 AC 清单
    expect(port.questions).toHaveLength(1);
    expect(port.questions[0][0].id).toBe('Q1');
    expect(port.reports.map((r) => r.title)).toEqual(['验收结果 PASS']);

    const s = snap(T);
    expect(s.cursor).toBe('compound');
    expect(s.pendingGate).toBeUndefined();
    expect(s.haltedReason).toBeUndefined();
    expect(s.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(s.reviewFixRounds).toBe(0);
    expect(s.runs.map((r) => `${r.stage}:${r.extraArgs || r.status}`)).toEqual([
      'clarify:DONE',
      'clarify:prototype', // 原型成本记为 clarify 的附属会话
      'plan:DONE',
      'implement:DONE',
      'review:DONE',
      'acceptance:NEEDS_CONTEXT',
      'acceptance:DONE',
      'compound:DONE',
    ]);
    expect(s.runs[3].model).toBe('opus'); // implement 模型冻结进记录

    expect(events(T, 'ticket.created')).toHaveLength(1);
    expect(events(T, 'gate.asked')).toEqual(['卡点 prd-confirm 等待人工', '卡点 plan-approval 等待人工']);
    expect(events(T, 'gate.answered')).toEqual(['卡点 prd-confirm → 通过', '卡点 plan-approval → 通过']);
    expect(events(T, 'question.asked')).toEqual(['1 个待确认问题：Q1']);
    expect(events(T, 'question.answered')).toEqual(['Q1 → 通过']);
    expect(events(T, 'stage.end')).toHaveLength(7);
    expect(events(T, 'done').at(-1)).toMatch(/^闭环：8 次会话/);
    expect(port.notifications.at(-1)).toMatch(/^流水线闭环。共 8 次会话/);

    const acceptance = fs.readFileSync(path.join(ticketDir(repo, T), '40-acceptance.md'), 'utf-8');
    expect(acceptance).toContain('## 人工验收结果');
    expect(acceptance).toContain('答：通过');
    expect(fs.existsSync(path.join(dataRoot, `${T}.json`))).toBe(true); // 数据只落在临时目录
  });

  it('b1. review BLOCK → 修复轮（implement 带 fix= 指向该轮评审）→ review PASS → 闭环', async () => {
    const repo = makeRepo();
    const T = 'IT-2';
    const engine = new FakeEngine().on('review', { verdict: 'BLOCK', status: 'DONE_WITH_CONCERNS', concerns: ['Critical：空态未处理'] }, {});
    const port = new ScriptedPort();

    await runTicket({ repo, ticket: T, port, lane: 'full', startStage: 'implement', requirement: 'x', stageRunner: engine.run, prototype: fakePrototype });

    expect(stages(engine)).toEqual(['implement', 'review', 'implement', 'review', 'acceptance', 'compound']);
    expect(engine.calls[2].extraArgs).toBe(`fix=docs/pipeline/${T}/30-review-r1.md`);
    expect(engine.calls[3].extraArgs).toMatch(/^base=/);
    const s = snap(T);
    expect(s.reviewFixRounds).toBe(1);
    expect(s.pendingReverify).toBeNull();
    expect(s.pendingExtraArgs).toBeUndefined(); // fix= 已被 implement 取用
    expect(s.haltedReason).toBeUndefined();
    expect(port.gates).toHaveLength(0);
    expect(events(T, 'stage.start')).toContain(`阶段 implement 开始（fix=docs/pipeline/${T}/30-review-r1.md）`);
  });

  it('b2. review 连续 BLOCK 达 FIX_ROUND_CAP → 挂起转人工仲裁，仲裁卡驳回后 runner 退出', async () => {
    const repo = makeRepo();
    const T = 'IT-3';
    const block: Step = { verdict: 'BLOCK', status: 'DONE_WITH_CONCERNS', concerns: ['Critical：仍未修'] };
    const engine = new FakeEngine().on('review', block, block, block);
    const port = new ScriptedPort().gate(reject('先人工看看'));

    await runTicket({ repo, ticket: T, port, lane: 'full', startStage: 'implement', requirement: 'x', stageRunner: engine.run, prototype: fakePrototype });

    expect(stages(engine)).toEqual(['implement', 'review', 'implement', 'review', 'implement', 'review']);
    expect(engine.calls[4].extraArgs).toBe(`fix=docs/pipeline/${T}/30-review-r2.md`);
    const s = snap(T);
    expect(s.reviewFixRounds).toBe(2);
    expect(s.cursor).toBe('review');
    expect(s.haltedReason).toBe('review 打回已达 2 轮上限，转人工仲裁');
    expect(port.gates.map((g) => g.gate)).toEqual(['review-arbitration']);
    expect(events(T, 'halt')).toEqual(['review 打回已达 2 轮上限，转人工仲裁']);
    expect(events(T, 'gate.answered').at(-1)).toBe('评审仲裁 → 保持挂起（先人工看看）');
    expect(port.notifications.at(-1)).toContain('已挂起：review 打回已达 2 轮上限');
    expect(fs.readFileSync(path.join(ticketDir(repo, T), 'feedback.md'), 'utf-8')).toContain('先人工看看');
  });

  it('c. 卡点跨重启持久化：plan-approval 没人答 → 第二个 runner 原样重发这张卡、不重跑 plan、答复后才进 implement（OP-002 回归）', async () => {
    const repo = makeRepo();
    const T = 'IT-4';
    const engine1 = new FakeEngine();
    const port1 = new ScriptedPort().gate(approve, 'hang');
    // 第一个 runner：卡在 plan-approval 上永远等不到答复（模拟 daemon 在此刻被重启）
    void runTicket({ repo, ticket: T, port: port1, lane: 'full', requirement: 'x', stageRunner: engine1.run, prototype: fakePrototype });
    await waitFor(() => {
      const s = readSnapshot(T);
      return s?.pendingGate?.gate === 'plan-approval' && s.cursor === 'implement';
    }, 'plan-approval 卡落盘');
    expect(stages(engine1)).toEqual(['clarify', 'plan']);
    expect(port1.gates.map((g) => g.gate)).toEqual(['prd-confirm', 'plan-approval']);

    // 第二个 runner（重启后的 daemon）：游标已在 implement，但盘上有待答卡
    const engine2 = new FakeEngine();
    const port2 = new ScriptedPort().gate(approve);
    await runTicket({ repo, ticket: T, port: port2, stageRunner: engine2.run, prototype: fakePrototype });

    expect(port2.notifications[0]).toBe('重启前的 plan-approval 卡未得到答复，原样重发（plan 阶段产物未变，不重跑）');
    expect(port2.gates.map((g) => g.gate)).toEqual(['plan-approval']);
    expect(port2.gates[0].summary).toBe(port1.gates[1].summary); // 原样：摘要一字不差
    expect(stages(engine2)).toEqual(['implement', 'review', 'acceptance', 'compound']); // 没有 plan
    expect(stages(engine1)).toEqual(['clarify', 'plan']); // 挂着的旧 runner 没被唤醒
    const s = snap(T);
    expect(s.pendingGate).toBeUndefined();
    expect(s.cursor).toBe('compound');
    expect(events(T, 'gate.asked')).toEqual(['卡点 prd-confirm 等待人工', '卡点 plan-approval 等待人工', '卡点 plan-approval 等待人工']);
    expect(events(T, 'gate.answered')).toEqual(['卡点 prd-confirm → 通过', '卡点 plan-approval → 通过']);
  });

  it('d. 项目约定 testEnv:none + release:manual：人工验收项不弹卡、上线审批卡、上线后补验异步不阻塞 compound', async () => {
    const repo = makeRepo();
    const T = 'IT-5';
    fs.writeFileSync(
      path.join(repo, 'docs', 'pipeline', 'PIPELINE.md'),
      ['---', 'testEnv: none', 'acceptor: ops', 'release: manual', '---', '# 约定', '', '## 全阶段', '', '测试库用 demo。', '', '## release', '', '上线后手动升级模块。', ''].join('\n'),
      'utf-8',
    );
    const engine = new FakeEngine().on('acceptance', { status: 'NEEDS_CONTEXT', verdict: null, open_questions: [HUMAN_Q] }, {});
    const port = new ScriptedPort().gate(approve, approve, approve).answers('defer');

    await runTicket({ repo, ticket: T, port, lane: 'full', requirement: 'x', stageRunner: engine.run, prototype: fakePrototype });

    expect(stages(engine)).toEqual(['clarify', 'plan', 'implement', 'review', 'acceptance', 'acceptance', 'compound']);
    expect(port.gates.map((g) => g.gate)).toEqual(['prd-confirm', 'plan-approval', 'release-approval']);
    const release = port.gates[2].summary;
    expect(release).toContain('**上线方式**：人工上线（编排器发上线清单，人完成后点确认）');
    expect(release).toContain('**上线后待补验 1 项**');
    expect(release).toContain('- Q1 空态提示文案是否符合业务口径？');
    expect(release).toContain('**项目上线约定**：\n上线后手动升级模块。');
    expect(release).toContain('本项目为人工上线');
    // 验收的人工项没有弹卡；唯一一次提问是上线后的补验卡，且尚未有人答
    expect(port.questions).toHaveLength(1);
    expect(port.questions[0][0].question).toBe(`【上线后补验】${HUMAN_Q.question}`);
    expect(port.deferred).toHaveLength(1);
    expect(port.notifications).toContain('验收的 1 个人工项（Q1）因本项目无测试环境暂记「无法验证」，上线后会再弹卡补验');

    const acceptanceFile = path.join(ticketDir(repo, T), '40-acceptance.md');
    expect(fs.readFileSync(acceptanceFile, 'utf-8')).toContain('答：无法验证（备注：项目无测试环境（docs/pipeline/PIPELINE.md testEnv: none），转上线后补验）');
    expect(fs.readFileSync(path.join(ticketDir(repo, T), '07-project-profile.md'), 'utf-8')).toContain('测试库用 demo。');

    let s = snap(T);
    expect(s.releaseApproved).toBe(true);
    expect(s.released).toBe(true);
    expect(s.postReleaseChecks).toEqual([HUMAN_Q]); // compound 已跑完，补验待办仍在盘上等人
    expect(s.runs.at(-1)?.stage).toBe('compound');
    expect(events(T, 'release')).toEqual(['人工上线已确认']);
    expect(events(T, 'question.asked')).toEqual(['1 个待确认问题：Q1', '上线后补验 1 项：Q1']);
    expect(events(T, 'done').at(-1)).toMatch(/^闭环：/);

    // 几天后运营答了补验卡：写回 40-acceptance.md，只清盘上的待办
    port.deferred[0].resolve([{ id: 'Q1', question: HUMAN_Q.question, answer: '通过' }]);
    await waitFor(() => readSnapshot(T)?.postReleaseChecks?.length === 0, '补验待办清空');
    s = snap(T);
    expect(s.released).toBe(true);
    expect(s.runs.at(-1)?.stage).toBe('compound');
    expect(fs.readFileSync(acceptanceFile, 'utf-8')).toContain('## 上线后补验结果');
    expect(events(T, 'question.answered')).toContain('Q1 → 通过');
  });

  it('e. 瞬时 API 故障（529）：同参数自动重跑一次并继续；修复轮 fix= 由 pendingReverify 在重进时重建', async () => {
    const repo = makeRepo();
    const T = 'IT-6';
    // 盘上已是「挂起后重进的修复轮」：cursor=implement、pendingReverify=review、fix= 指针已被上一进程消费掉
    const dir = ticketDir(repo, T);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '00-intake.md'), `# ${T} 原始需求\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, '30-review-r1.md'), '# 评审 r1\n\n## 本阶段结论\n\nBLOCK\n', 'utf-8');
    saveTicket({
      ticket: T,
      repo,
      cursor: 'implement',
      reviewFixRounds: 1,
      acceptanceFixRounds: 0,
      pendingReverify: 'review',
      lane: 'full',
      ciEnabled: false,
      runs: [],
    });
    const engine = new FakeEngine()
      .on('implement', { is_error: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, {})
      .on('review', { status: 'BLOCKED', verdict: null, blocked_reason: '评审环境不可用' });
    const port = new ScriptedPort().gate(reject('等环境恢复'));

    await runTicket({ repo, ticket: T, port, stageRunner: engine.run, prototype: fakePrototype, transientRetryDelayMs: 10 });

    expect(stages(engine)).toEqual(['implement', 'implement', 'review']);
    const fixArgs = `fix=docs/pipeline/${T}/30-review-r1.md`;
    expect(engine.calls[0].extraArgs).toBe(fixArgs); // 重建自 pendingReverify
    expect(engine.calls[1].extraArgs).toBe(fixArgs); // 重试带同样的参数
    expect(events(T, 'error')).toHaveLength(1);
    expect(events(T, 'error')[0]).toMatch(/^会话异常：API Error: 529 .*｜疑似瞬时故障，0 分钟后自动重试一次$/);
    expect(port.notifications.some((m) => m.includes('疑似 API 瞬时故障') && m.includes('自动从 implement 阶段重跑一次'))).toBe(true);
    // 重试成功后流程照走：review BLOCKED → 挂起 → 挂起处理卡 → 驳回 → 退出
    const s = snap(T);
    expect(s.haltedReason).toBe('评审环境不可用');
    expect(s.pendingReverify).toBeNull();
    expect(s.runs.map((r) => r.stage)).toEqual(['implement', 'review']); // 出错的那次不落账
    expect(port.gates.map((g) => g.gate)).toEqual(['挂起处理']);
    expect(port.notifications.at(-1)).toBe(`已挂起：评审环境不可用。处理后续跑，或在群里说「继续 ${T}」`);
  });

  it('e2. 非瞬时错误（400）不重试：记 error 事件、教人怎么恢复、runner 退出且游标不动', async () => {
    const repo = makeRepo();
    const T = 'IT-7';
    const engine = new FakeEngine().on('implement', { is_error: 'API Error: 400 invalid_request_error' });
    const port = new ScriptedPort();

    await runTicket({ repo, ticket: T, port, lane: 'full', startStage: 'implement', requirement: 'x', stageRunner: engine.run, prototype: fakePrototype, transientRetryDelayMs: 10 });

    expect(stages(engine)).toEqual(['implement']);
    expect(port.gates).toHaveLength(0);
    expect(events(T, 'error')).toEqual(['会话异常：API Error: 400 invalid_request_error']);
    expect(port.notifications.at(-1)).toBe(`会话异常：API Error: 400 invalid_request_error\n本阶段未产生结果（通常是瞬时故障）。在群里说「继续 ${T}」即可从 implement 阶段重跑`);
    const s = snap(T);
    expect(s.cursor).toBe('implement');
    expect(s.haltedReason).toBeUndefined();
    expect(s.runs).toEqual([]);
  });
});
