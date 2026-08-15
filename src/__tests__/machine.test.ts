import { describe, expect, it } from 'vitest';
import { applyResult, route } from '../machine.js';
import type { StageResult, TicketState } from '../types.js';

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

  it('修复轮完成后清除 pendingReverify', () => {
    const s0 = state({ cursor: 'implement', pendingReverify: 'review', reviewFixRounds: 1 });
    const r = res({ stage: 'implement' });
    const a = route(s0, r);
    const s1 = applyResult(s0, r, a, 1, 10, 'sid');
    expect(s1.cursor).toBe('review');
    expect(s1.pendingReverify).toBeNull();
  });
});
