import { describe, expect, it } from 'vitest';
import { nodeDedupKey } from '../bitable/client.js';
import { artifactUrl, currentStage, nodeRow, runState, ticketRow, waitingOn } from '../bitable/project.js';
import { NODE_FIELDS, RESULT_OPTIONS, STAGE_OPTIONS, TICKET_FIELDS, VERDICT_OPTIONS } from '../bitable/schema.js';
import type { PipelineEvent } from '../events.js';
import type { TicketState } from '../types.js';

const cfg = {
  gitlabUrl: 'http://git.happotech.com',
  repoToProject: { 'D:/work/lake_spirit': 'songxulin/lakeghost' },
  defaultBranch: 'master',
};

function state(over: Partial<TicketState> = {}): TicketState {
  return {
    ticket: 'LS-003',
    repo: 'D:/work/lake_spirit',
    cursor: 'review',
    reviewFixRounds: 1,
    acceptanceFixRounds: 0,
    pendingReverify: null,
    lane: 'full',
    runs: [
      { stage: 'clarify', extraArgs: '', startedAt: '2026-08-13T06:00:00.000Z', costUsd: 1.5, turns: 20, status: 'DONE', sessionId: 's1' },
      { stage: 'implement', extraArgs: '', startedAt: '2026-08-13T07:00:00.000Z', costUsd: 14.29, turns: 60, status: 'DONE_WITH_CONCERNS', sessionId: 's2' },
    ],
    ...over,
  };
}

const ev = (over: Partial<PipelineEvent>): PipelineEvent => ({
  ts: '2026-08-13T08:53:58.000Z',
  ticket: 'LS-003',
  type: 'stage.end',
  summary: 'acceptance → DONE / PASS（$0.77，10 轮）',
  stage: 'acceptance',
  ...over,
});

describe('节点行表内去重键（2026-08-25 事故回归）', () => {
  // 幂等键只存在 data/bitable-index.json 里，表里没有这一列。索引为空时跑一次回填，
  // 205 行节点表被翻成 408 行、203 组重复——「记录+时间」是表内认出重复的依据。
  it('主字段的两种返回形态（富文本数组 / 纯字符串）产出同一个键', () => {
    expect(nodeDedupKey({ 记录: [{ text: 'LS-003 · 验收 · 第2轮' }], 时间: 1786610903652 })).toBe(
      nodeDedupKey({ 记录: 'LS-003 · 验收 · 第2轮', 时间: 1786610903652 }),
    );
  });

  it('同名不同时间、同时间不同名，都不算重复', () => {
    const a = nodeDedupKey({ 记录: 'LS-003 · 验收', 时间: 1 });
    expect(nodeDedupKey({ 记录: 'LS-003 · 验收', 时间: 2 })).not.toBe(a);
    expect(nodeDedupKey({ 记录: 'LS-003 · 评审', 时间: 1 })).not.toBe(a);
  });

  it('字段缺失不抛，产出可比较的空键', () => {
    expect(nodeDedupKey({})).toBe('|');
  });
});

describe('表结构定义', () => {
  it('主字段是文本类型（多维表格要求）', () => {
    expect(TICKET_FIELDS[0]).toMatchObject({ field_name: '工单号', type: 1 });
    expect(NODE_FIELDS[0]).toMatchObject({ field_name: '记录', type: 1 });
  });
  it('单选字段的选项覆盖全部枚举值（写入未定义选项会失败）', () => {
    const stage = TICKET_FIELDS.find((f) => f.field_name === '当前阶段')!;
    const names = (stage.property!.options as Array<{ name: string }>).map((o) => o.name);
    expect(names).toEqual(STAGE_OPTIONS);
    for (const r of ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']) expect(RESULT_OPTIONS).toContain(r);
    for (const v of ['PASS', 'PASS_WITH_SUGGESTIONS', 'BLOCK']) expect(VERDICT_OPTIONS).toContain(v);
  });
});

describe('工单行投影', () => {
  it('成本累加、回环计数、通道与分支映射', () => {
    const row = ticketRow(state(), [ev({ type: 'ticket.created', summary: '工单建立：给 /mcp 加限流' })], cfg, true);
    expect(row['工单号']).toBe('LS-003');
    expect(row['需求']).toBe('给 /mcp 加限流');
    expect(row['累计成本USD']).toBeCloseTo(15.79);
    expect(row['会话数']).toBe(2);
    expect(row['评审回环']).toBe(1);
    expect(row['通道']).toBe('全流水线');
    expect(row['分支']).toBe(''); // 快照里没有探测到的分支就留空，不编造
  });

  // 2026-08-25 实测：这两列的链接从来没有可能打开——分支名是拼的（真实是
  // feat/LS-012-org-call-monitor 这种带 slug 的），目录又用了 /-/blob/。
  describe('工件链接（历史缺陷回归）', () => {
    it('工件目录用 tree + 默认分支，不用编造的特性分支', () => {
      const row = ticketRow(state({ branch: 'feat/LS-003-mcp-nginx-rate-limit' }), [], cfg, false);
      expect(row['工件目录']).toMatchObject({
        link: 'http://git.happotech.com/songxulin/lakeghost/-/tree/master/docs/pipeline/LS-003',
      });
    });

    it('产物是文件，用 blob + 默认分支', () => {
      expect(artifactUrl(cfg, state(), 'docs/pipeline/LS-003/40-acceptance.md')).toBe(
        'http://git.happotech.com/songxulin/lakeghost/-/blob/master/docs/pipeline/LS-003/40-acceptance.md',
      );
    });

    it('链接不受特性分支存亡影响：合并后分支被删，链接照样有效', () => {
      const merged = artifactUrl(cfg, state({ branch: 'feat/LS-003-已被删除' }), 'docs/pipeline/LS-003', 'tree');
      expect(merged).toContain('/-/tree/master/');
      expect(merged).not.toContain('feat/');
    });

    it('默认分支可配（不是所有仓库都叫 master）', () => {
      expect(artifactUrl({ ...cfg, defaultBranch: 'main' }, state(), 'a.md')).toContain('/-/blob/main/a.md');
    });

    it('探测到的真实分支进「分支」列，与链接的 ref 分开', () => {
      const row = ticketRow(state({ branch: 'feat/LS-012-org-call-monitor' }), [], cfg, false);
      expect(row['分支']).toBe('feat/LS-012-org-call-monitor');
      expect((row['工件目录'] as { link: string }).link).toContain('/-/tree/master/');
    });
  });

  it('运行状态：挂起 / 在跑 / 等人工 / 闭环四态可区分', () => {
    expect(runState(state({ haltedReason: 'CI 失败' }), false)).toBe('挂起');
    expect(runState(state(), true)).toBe('在跑');
    expect(runState(state(), false)).toBe('等人工');
    const closed = state({
      cursor: 'compound',
      runs: [...state().runs, { stage: 'compound', extraArgs: '', startedAt: 'x', costUsd: 1, turns: 5, status: 'DONE', sessionId: 's' }],
    });
    expect(runState(closed, false)).toBe('闭环');
    expect(currentStage(closed)).toBe('已闭环');
  });

  it('「当前在等」能指出卡在哪：待答问题 / 卡点 / 会话进行中 / 挂起', () => {
    expect(waitingOn(state(), [ev({ type: 'question.asked', summary: '8 个待确认问题：Q1, Q2' })])).toContain('8 个待确认问题');
    expect(waitingOn(state(), [ev({ type: 'gate.asked', summary: '卡点 plan-approval 等待人工' })])).toContain('plan-approval');
    expect(waitingOn(state(), [ev({ type: 'stage.start', stage: 'implement', summary: 'x' })])).toBe('实现 会话进行中');
    expect(waitingOn(state({ haltedReason: '构建失败' }), [])).toContain('挂起：构建失败');
  });

  it('无 GitLab 映射时不写死链接（宁可留空）', () => {
    expect(artifactUrl({}, state(), 'docs/x.md')).toBeNull();
    expect(artifactUrl(cfg, state({ repo: 'D:/other', mainRepo: 'D:/other' }), 'docs/x.md')).toBeNull();
  });
});

describe('节点行投影', () => {
  it('stage.end：解析结果与结论、成本轮数、产物链接，轮次进标题', () => {
    const row = nodeRow(ev({ payload: { costUsd: 0.77, turns: 10, handoff: 'docs/pipeline/LS-003/40-acceptance.md' } }), state(), cfg, () => 2)!;
    expect(row.fields['记录']).toBe('LS-003 · 验收 · 第2轮');
    expect(row.fields['阶段']).toBe('验收');
    expect(row.fields['结果']).toBe('DONE');
    expect(row.fields['结论']).toBe('PASS');
    expect(row.fields['成本USD']).toBeCloseTo(0.77);
    expect(row.fields['轮数']).toBe(10);
    expect(row.fields['产物']).toMatchObject({ text: '40-acceptance.md' });
  });

  it('长枚举优先匹配：DONE_WITH_CONCERNS 不被 DONE 抢走，PASS_WITH_SUGGESTIONS 同理', () => {
    const r = nodeRow(ev({ summary: 'review → DONE_WITH_CONCERNS / PASS_WITH_SUGGESTIONS（$2.28）', stage: 'review' }), state(), cfg, () => 1)!;
    expect(r.fields['结果']).toBe('DONE_WITH_CONCERNS');
    expect(r.fields['结论']).toBe('PASS_WITH_SUGGESTIONS');
  });

  it('人工回答按题号区分记录名（一轮 8 题不能产生 8 条同名行）', () => {
    const a = nodeRow(ev({ type: 'question.answered', summary: 'Q7 → 通过', stage: 'acceptance' }), state(), cfg, () => 1)!;
    const b = nodeRow(ev({ type: 'question.answered', summary: 'Q8 → 不通过｜补充：页面报 500', stage: 'acceptance' }), state(), cfg, () => 1)!;
    expect(a.fields['记录']).toBe('LS-003 · 人工回答 Q7（验收）');
    expect(b.fields['记录']).toBe('LS-003 · 人工回答 Q8（验收）');
    expect(b.fields['人工决策']).toContain('页面报 500');
  });

  it('人工决策类事件写入「人工决策」列而非摘要', () => {
    const r = nodeRow(ev({ type: 'gate.answered', summary: '卡点 plan-approval → 驳回（计划漏了限流）', stage: 'plan' }), state(), cfg, () => 1)!;
    expect(r.fields['记录']).toContain('卡点决策');
    expect(r.fields['人工决策']).toContain('驳回');
    expect(r.fields['摘要']).toBeUndefined();
  });

  it('过程类事件不投影（避免看板被 stage.start 刷满）', () => {
    for (const t of ['stage.start', 'question.asked', 'gate.asked', 'pause', 'resume', 'error'] as const) {
      expect(nodeRow(ev({ type: t }), state(), cfg, () => 1)).toBeNull();
    }
  });

  it('幂等键：完全相同的事件去重', () => {
    const a = nodeRow(ev({}), state(), cfg, () => 1)!;
    const b = nodeRow(ev({}), state(), cfg, () => 1)!;
    expect(a.key).toBe(b.key);
  });

  it('同一毫秒的多条人工回答必须各自成键（真机静默丢数据回归）', () => {
    const ts = '2026-08-13T08:51:37.321Z';
    const keys = ['Q1 → 通过', 'Q2 → 通过', 'Q3 → 通过', 'Q4 → 不通过', 'Q5 → 通过', 'Q6 → 通过', 'Q7 → 通过', 'Q8 → 通过'].map(
      (summary) => nodeRow(ev({ ts, type: 'question.answered', summary, stage: 'acceptance' }), state(), cfg, () => 1)!.key,
    );
    expect(new Set(keys).size).toBe(8);
  });
});
