import { afterEach, describe, expect, it } from 'vitest';
import { resolveImplementModel, STAGES } from '../config.js';
import { applyResult, route, unconsumedReviewBlocks } from '../machine.js';
import type { RunRecord, StageResult, TicketState } from '../types.js';

function state(over: Partial<TicketState> = {}): TicketState {
  return {
    ticket: 'T-1',
    repo: '/repo',
    cursor: 'clarify',
    reviewFixRounds: 0,
    acceptanceFixRounds: 0,
    pendingReverify: null,
    runs: [],
    ...over,
  };
}

function res(over: Partial<StageResult>): StageResult {
  return {
    stage: 'clarify',
    status: 'DONE',
    handoff_path: 'docs/pipeline/T-1/10-prd.md',
    summary_for_card: 's',
    ...over,
  };
}

describe('route：试跑验证过的全部路径', () => {
  it('clarify NEEDS_CONTEXT → 表单提问后重跑本阶段（回填 00-intake.md）', () => {
    const a = route(
      state(),
      res({
        status: 'NEEDS_CONTEXT',
        open_questions: [{ id: 'Q1', question: 'q', recommended: 'r', why: 'w' }],
      }),
    );
    expect(a).toMatchObject({ kind: 'ask', backfillTarget: '00-intake.md', thenRerun: 'clarify' });
  });

  it('clarify DONE → 业务确认卡点 → plan', () => {
    expect(route(state(), res({}))).toMatchObject({ kind: 'gate', gate: 'prd-confirm', then: 'plan' });
  });

  it('plan DONE_WITH_CONCERNS → 审批卡点（concerns 附卡片）→ implement', () => {
    const a = route(
      state({ cursor: 'plan' }),
      res({ stage: 'plan', status: 'DONE_WITH_CONCERNS', concerns: ['c1'] }),
    );
    expect(a).toMatchObject({ kind: 'gate', gate: 'plan-approval', then: 'implement', concerns: ['c1'] });
  });

  it('implement 常规完成 → review', () => {
    expect(route(state({ cursor: 'implement' }), res({ stage: 'implement' }))).toMatchObject({
      kind: 'run',
      stage: 'review',
    });
  });

  it('implement 修复轮完成 → 回到来源阶段复验', () => {
    const a = route(state({ cursor: 'implement', pendingReverify: 'acceptance' }), res({ stage: 'implement' }));
    expect(a).toMatchObject({ kind: 'run', stage: 'acceptance' });
  });

  it('review PASS_WITH_SUGGESTIONS → acceptance', () => {
    const a = route(state({ cursor: 'review' }), res({ stage: 'review', verdict: 'PASS_WITH_SUGGESTIONS' }));
    expect(a).toMatchObject({ kind: 'run', stage: 'acceptance' });
  });

  it('review BLOCK 第 1、2 轮 → 修复轮；第 3 次 → 转人工', () => {
    const r = res({ stage: 'review', verdict: 'BLOCK', handoff_path: 'docs/pipeline/T-1/30-review-r1.md' });
    expect(route(state({ cursor: 'review' }), r)).toMatchObject({ kind: 'fix', reverify: 'review' });
    expect(route(state({ cursor: 'review', reviewFixRounds: 1 }), r)).toMatchObject({ kind: 'fix' });
    expect(route(state({ cursor: 'review', reviewFixRounds: 2 }), r)).toMatchObject({ kind: 'halt' });
  });

  it('acceptance BLOCK → 修复轮（findings=40-acceptance.md）；超限 → 转人工', () => {
    const r = res({ stage: 'acceptance', verdict: 'BLOCK', handoff_path: 'docs/pipeline/T-1/40-acceptance.md' });
    expect(route(state({ cursor: 'acceptance' }), r)).toMatchObject({
      kind: 'fix',
      findingsPath: 'docs/pipeline/T-1/40-acceptance.md',
      reverify: 'acceptance',
    });
    expect(route(state({ cursor: 'acceptance', acceptanceFixRounds: 2 }), r)).toMatchObject({ kind: 'halt' });
  });

  it('acceptance PASS → compound；compound DONE → done', () => {
    expect(route(state({ cursor: 'acceptance' }), res({ stage: 'acceptance', verdict: 'PASS' }))).toMatchObject({
      kind: 'run',
      stage: 'compound',
    });
    expect(route(state({ cursor: 'compound' }), res({ stage: 'compound' }))).toMatchObject({ kind: 'done' });
  });

  it('任意阶段 BLOCKED → halt 并带原因', () => {
    const a = route(state({ cursor: 'plan' }), res({ stage: 'plan', status: 'BLOCKED', blocked_reason: 'PRD 未就绪' }));
    expect(a).toMatchObject({ kind: 'halt', reason: 'PRD 未就绪' });
  });

  it('阶段错位（返回 stage ≠ 游标）→ halt', () => {
    expect(route(state({ cursor: 'plan' }), res({ stage: 'review', verdict: 'PASS' }))).toMatchObject({ kind: 'halt' });
  });
});

describe('implement 对照实验臂', () => {
  afterEach(() => {
    delete process.env.PIPELINE_IMPLEMENT_MODEL;
  });

  it('未设环境变量 → 默认配置，且不发群通知', () => {
    expect(resolveImplementModel()).toEqual({ model: STAGES.implement.model });
  });

  it('设了有效臂 → 用它，并给出必须公示的说明', () => {
    process.env.PIPELINE_IMPLEMENT_MODEL = 'sonnet';
    const r = resolveImplementModel();
    expect(r.model).toBe('sonnet');
    expect(r.note).toContain('对照实验');
  });

  it('工单已冻结 → 环境变量改了也不换臂（同一单不许混臂）', () => {
    process.env.PIPELINE_IMPLEMENT_MODEL = 'sonnet';
    expect(resolveImplementModel('opus')).toEqual({ model: 'opus' });
  });

  it('无效值 → 回落默认并明说，不拿错模型硬跑', () => {
    process.env.PIPELINE_IMPLEMENT_MODEL = 'sonnet-4-5-bogus';
    const r = resolveImplementModel();
    expect(r.model).toBe(STAGES.implement.model);
    expect(r.note).toContain('不是有效实验臂');
  });
});

function run(stage: RunRecord['stage'], verdict?: RunRecord['verdict']): RunRecord {
  return { stage, extraArgs: '', startedAt: '', costUsd: 0, turns: 0, status: 'DONE', verdict, sessionId: 's' };
}

describe('未消化的 BLOCK 评审轮（LS-012 回归：r3/r4 的 Critical 未修，r5 漏检 PASS 走完验收）', () => {
  it('BLOCK 后跑过修复轮 → 已消化，不报', () => {
    expect(unconsumedReviewBlocks([run('review', 'BLOCK'), run('implement'), run('review', 'PASS')])).toEqual([]);
    expect(unconsumedReviewBlocks([])).toEqual([]);
  });

  it('LS-012 时序：r1/r2 有修复轮、r3/r4 没有 → 报第 3、4 轮', () => {
    const runs = [
      run('implement'),
      run('review', 'BLOCK'), // r1
      run('implement'),
      run('review', 'BLOCK'), // r2
      run('implement'),
      run('review', 'BLOCK'), // r3 —— 达上限挂起，此后再无 implement
      run('review', 'BLOCK'), // r4 —— 人工重试重跑 review
    ];
    expect(unconsumedReviewBlocks(runs)).toEqual([3, 4]);
  });

  it('review 通过但存在未消化 BLOCK → 放行卡 concerns 带警示', () => {
    const s = state({
      cursor: 'review',
      ciEnabled: true,
      runs: [run('review', 'BLOCK'), run('review', 'BLOCK')],
    });
    const a = route(s, res({ stage: 'review', verdict: 'PASS_WITH_SUGGESTIONS', concerns: ['既有 concern'] }));
    expect(a).toMatchObject({ kind: 'gate', gate: 'deploy-approval' });
    if (a.kind !== 'gate') throw new Error('unreachable');
    expect(a.concerns[0]).toBe('既有 concern');
    expect(a.concerns[1]).toContain('第 1、2 轮');
    expect(a.concerns[1]).toContain('未经修复轮');
  });

  it('BLOCK 均已消化 → 放行卡不加警示', () => {
    const s = state({
      cursor: 'review',
      ciEnabled: true,
      runs: [run('review', 'BLOCK'), run('implement')],
    });
    const a = route(s, res({ stage: 'review', verdict: 'PASS' }));
    if (a.kind !== 'gate') throw new Error('unreachable');
    expect(a.concerns).toEqual([]);
  });
});

describe('applyResult：计数器与游标', () => {
  it('fix 动作推进 implement 并累加对应回环计数', () => {
    const s0 = state({ cursor: 'acceptance' });
    const r = res({ stage: 'acceptance', verdict: 'BLOCK', handoff_path: 'p' });
    const a = route(s0, r);
    const s1 = applyResult(s0, r, a, 1, 10, 'sid');
    expect(s1.cursor).toBe('implement');
    expect(s1.pendingReverify).toBe('acceptance');
    expect(s1.acceptanceFixRounds).toBe(1);
    expect(s1.runs).toHaveLength(1);
  });

  it('落账记下本次会话用的模型（对照实验的分组键）', () => {
    const s0 = state({ cursor: 'implement' });
    const r = res({ stage: 'implement' });
    const s1 = applyResult(s0, r, route(s0, r), 1, 10, 'sid', 'sonnet');
    expect(s1.runs[0].model).toBe('sonnet');
    // 不传 = 早于本字段的历史记录，保持 undefined 而不是替它假设默认模型
    expect(applyResult(s0, r, route(s0, r), 1, 10, 'sid').runs[0].model).toBeUndefined();
  });

  it('修复轮完成后清除 pendingReverify', () => {
    const s0 = state({ cursor: 'implement', pendingReverify: 'review', reviewFixRounds: 1 });
    const r = res({ stage: 'implement' });
    const a = route(s0, r);
    const s1 = applyResult(s0, r, a, 1, 10, 'sid');
    expect(s1.cursor).toBe('review');
    expect(s1.pendingReverify).toBeNull();
  });
});
