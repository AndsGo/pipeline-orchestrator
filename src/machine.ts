import { BACKFILL, FIX_ROUND_CAP } from './config.js';
import type { Action, RunRecord, Stage, StageResult, TicketState } from './types.js';

const NEXT: Partial<Record<Stage, Stage>> = {
  implement: 'review',
  ci: 'acceptance',
  acceptance: 'compound',
};

/**
 * 未消化的 BLOCK 评审轮：verdict=BLOCK 且其后再没有跑过任何 implement（修复轮）的 review，
 * 返回轮次序号（第 N 轮 review，1 起）。这些轮的阻断项从未被修复过——后续 review 即使通过，
 * 也可能只是那一轮的分析路径恰好没再踩到（LS-012：r3/r4 两轮独立确认的 Critical 未修，
 * 人工重试后的 r5 漏检并 PASS，缺陷带着"通过"走完了验收）。
 */
export function unconsumedReviewBlocks(runs: readonly RunRecord[]): number[] {
  const rounds: number[] = [];
  let round = 0;
  runs.forEach((r, i) => {
    if (r.stage !== 'review') return;
    round += 1;
    if (r.verdict !== 'BLOCK') return;
    if (!runs.slice(i + 1).some((later) => later.stage === 'implement')) rounds.push(round);
  });
  return rounds;
}

/**
 * 流水线路由核心：给定工单状态与刚返回的阶段结果，决定下一步动作。
 * 纯函数——不做 IO，不改 state；计数器等状态变更由 applyResult 处理。
 */
export function route(state: TicketState, res: StageResult): Action {
  if (res.stage !== state.cursor) {
    return { kind: 'halt', reason: `阶段错位：期望 ${state.cursor}，返回 ${res.stage}` };
  }

  if (res.status === 'BLOCKED') {
    return { kind: 'halt', reason: res.blocked_reason ?? 'BLOCKED（未给出原因）' };
  }

  if (res.status === 'NEEDS_CONTEXT') {
    const bf = BACKFILL[res.stage];
    if (!bf || !res.open_questions?.length) {
      return { kind: 'halt', reason: `${res.stage} 返回 NEEDS_CONTEXT 但无可用回填通道或问题为空` };
    }
    return {
      kind: 'ask',
      questions: res.open_questions,
      backfillTarget: bf.target,
      backfillHeader: bf.header,
      thenRerun: res.stage,
    };
  }

  // DONE / DONE_WITH_CONCERNS
  const concerns = [...(res.concerns ?? [])];
  switch (res.stage) {
    case 'clarify':
      return { kind: 'gate', gate: 'prd-confirm', summary: res.summary_for_card, concerns, then: 'plan' };

    case 'plan':
      return { kind: 'gate', gate: 'plan-approval', summary: res.summary_for_card, concerns, then: 'implement' };

    case 'implement':
      // 修复轮完成 → 回到来源阶段复验；常规完成 → 进入 review
      if (state.pendingReverify) {
        return { kind: 'run', stage: state.pendingReverify };
      }
      return { kind: 'run', stage: NEXT.implement! };

    case 'review': {
      if (res.verdict === 'BLOCK') {
        if (state.reviewFixRounds >= FIX_ROUND_CAP) {
          return { kind: 'halt', reason: `review 打回已达 ${FIX_ROUND_CAP} 轮上限，转人工仲裁` };
        }
        return { kind: 'fix', findingsPath: res.handoff_path, reverify: 'review' };
      }
      // 既往 BLOCK 未经修复轮就通过的，警示必须跟着放行卡走——否则放行人不知道自己在仲裁什么
      const stale = unconsumedReviewBlocks(state.runs);
      if (stale.length) {
        concerns.push(
          `⚠ 第 ${stale.join('、')} 轮 review 的 BLOCK 阻断项未经修复轮处理，本轮通过可能是漏检——放行前先对照该轮报告核实阻断项确已消失`,
        );
      }
      // 配了 Jenkins：上线审批 gate → ci；未配：直达 acceptance
      if (state.ciEnabled) {
        return { kind: 'gate', gate: 'deploy-approval', summary: res.summary_for_card, concerns, then: 'ci' };
      }
      return { kind: 'run', stage: 'acceptance' };
    }

    case 'ci':
      // CI 结果由 cli 合成：SUCCESS → DONE；失败在 cli 侧直接给 BLOCKED（走顶部通用分支 halt）
      return { kind: 'run', stage: NEXT.ci! };

    case 'acceptance': {
      if (res.verdict === 'BLOCK') {
        if (state.acceptanceFixRounds >= FIX_ROUND_CAP) {
          return { kind: 'halt', reason: `acceptance 打回已达 ${FIX_ROUND_CAP} 轮上限，转人工仲裁` };
        }
        return { kind: 'fix', findingsPath: res.handoff_path, reverify: 'acceptance' };
      }
      return { kind: 'run', stage: NEXT.acceptance! };
    }

    case 'compound':
      return { kind: 'done' };
  }
}

/** 卡点被驳回时，回退到产出该卡点材料的阶段重跑；上线审批驳回=决定不发布，直接挂起 */
export const GATE_SOURCE: Record<string, Stage | 'halt'> = {
  'prd-confirm': 'clarify',
  'plan-approval': 'plan',
  'deploy-approval': 'halt',
};

const VERDICT_RANK = { BLOCK: 2, PASS_WITH_SUGGESTIONS: 1, PASS: 0 } as const;

/**
 * P2 双评审取严：verdict 取更严的一方，handoff 指向更严那份评审文档；
 * 结论分歧显式记入 concerns（这是非确定性的信号，值得人知道）。
 */
export function mergeReviewResults(a: StageResult, b: StageResult): StageResult {
  const [strict, lenient] =
    VERDICT_RANK[(a.verdict ?? 'PASS') as keyof typeof VERDICT_RANK] >= VERDICT_RANK[(b.verdict ?? 'PASS') as keyof typeof VERDICT_RANK]
      ? [a, b]
      : [b, a];
  const concerns = [...new Set([...(a.concerns ?? []), ...(b.concerns ?? [])])];
  if (a.verdict !== b.verdict) {
    concerns.push(`双评审结论分歧：${a.verdict}（${a.handoff_path}） vs ${b.verdict}（${b.handoff_path}），已按更严的 ${strict.verdict} 路由`);
  }
  return {
    ...strict,
    status: concerns.length ? 'DONE_WITH_CONCERNS' : strict.status,
    concerns,
    summary_for_card:
      a.verdict === b.verdict
        ? strict.summary_for_card
        : `【双评审取严：${strict.verdict}】${strict.summary_for_card}`.slice(0, 500),
  };
}

/** 结果落账 + 按动作推进游标/计数器。返回新 state（不可变）。 */
export function applyResult(
  state: TicketState,
  res: StageResult,
  action: Action,
  costUsd: number,
  turns: number,
  sessionId: string,
  /** 本次会话实际用的模型（对照实验的分组键） */
  model?: string,
): TicketState {
  const next: TicketState = {
    ...state,
    runs: [
      ...state.runs,
      {
        stage: res.stage,
        extraArgs: '',
        startedAt: new Date().toISOString(),
        costUsd,
        turns,
        status: res.status,
        verdict: res.verdict ?? undefined,
        sessionId,
        model,
      },
    ],
  };

  switch (action.kind) {
    case 'run':
      next.cursor = action.stage;
      // implement 修复轮完成、即将复验 → 清除修复标记
      if (res.stage === 'implement' && state.pendingReverify) next.pendingReverify = null;
      return next;
    case 'gate':
      next.cursor = action.then;
      return next;
    case 'ask':
      next.cursor = action.thenRerun;
      return next;
    case 'fix':
      next.cursor = 'implement';
      next.pendingReverify = action.reverify;
      if (action.reverify === 'review') next.reviewFixRounds = state.reviewFixRounds + 1;
      else next.acceptanceFixRounds = state.acceptanceFixRounds + 1;
      return next;
    case 'halt':
      next.haltedReason = action.reason;
      return next;
    case 'done':
      return next;
  }
}
