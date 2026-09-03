import { FIX_ROUND_CAP, IMPLEMENT_AUTO_CONTINUE_CAP } from '../config.js';
import { appendEvent } from '../events.js';
import { appendFeedback } from '../feedback.js';
import { decideAutoContinue, readImplementProgress } from '../implementProgress.js';
import { unconsumedReviewBlocks } from '../machine.js';
import type { TicketRun } from './context.js';

/**
 * 工单处于挂起（haltedReason）时的处置：能自己续的自己续（implement 分批），
 * 该问人的发卡（评审仲裁 / 挂起重试），都不行就通知并退出。
 * 返回 'continue' = 已解除挂起、回到循环顶部；'return' = runner 退出，等人说「继续」。
 */
export async function handleHalted(run: TicketRun): Promise<'continue' | 'return'> {
  const { repo, ticket, port } = run;
  const state = run.state;
  const haltedReason = state.haltedReason!;
  appendEvent({ ticket, type: 'halt', stage: state.cursor, summary: haltedReason });
  // 大计划的 implement 装不进一次会话：只要台账显示上一批真有进展、任务还没做完，就自己续下一批，
  // 不必每批都等人在群里说一次「继续」（LS-012 一天里已经手工点了两次，按其分批建议还要再点三次）。
  if (state.cursor === 'implement') {
    const d = decideAutoContinue({
      before: run.implementBefore,
      now: readImplementProgress(repo, ticket),
      used: run.autoContinued,
      cap: IMPLEMENT_AUTO_CONTINUE_CAP,
    });
    if (d.ok) {
      run.autoContinued += 1;
      run.state = { ...run.state, haltedReason: undefined };
      run.save();
      appendEvent({ ticket, type: 'resume', stage: 'implement', summary: `自动续跑：${d.reason}` });
      await port.notify(ticket, `implement 未做完但有进展——${d.reason}。继续下一批，不用管`);
      return 'continue';
    }
    await port.notify(ticket, `未自动续跑：${d.reason}`);
  }
  // review 达轮上限的挂起：默认动作是「追加一轮修复」而不是「重跑 review」。
  // 重跑属于重摇骰子——哪一轮评审恰好漏检，工单就带着未修复的阻断项通过（LS-012：
  // r3/r4 两轮独立确认的 Critical，在人工点重试后的 r5 被漏检并 PASS，一路走完验收）。
  const lastRun = state.runs[state.runs.length - 1];
  if (state.cursor === 'review' && lastRun?.stage === 'review' && lastRun.verdict === 'BLOCK' && !run.offeredArbitration) {
    run.offeredArbitration = true;
    const stale = unconsumedReviewBlocks(state.runs);
    appendEvent({ ticket, type: 'gate.asked', stage: 'review', summary: `评审仲裁卡：第 ${stale.join('、')} 轮阻断项未消化` });
    const d = await port.confirmGate(
      ticket,
      'review-arbitration',
      `review 已打回到 ${FIX_ROUND_CAP} 轮上限，且第 ${stale.join('、')} 轮的 BLOCK 阻断项之后没有跑过修复轮。` +
        `直接重跑 review 等于重摇骰子——评审哪轮恰好漏检，工单就会带着未修复的阻断项通过。\n\n` +
        `通过 → 追加一轮 implement 修复（自动带上最新评审报告，备注会作为约束带入）\n` +
        `驳回 → 保持挂起；确要重跑 review 的话在群里说「继续 ${ticket}」`,
      [],
    );
    appendEvent({
      ticket,
      type: 'gate.answered',
      stage: 'review',
      summary: `评审仲裁 → ${d.approved ? '追加修复轮' : '保持挂起'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
    });
    if (d.approved) {
      if (d.note?.trim()) appendFeedback(repo, ticket, '评审仲裁：追加修复轮说明', d.note);
      // fix= 指针不在这里拼：循环顶部的 pendingReverify 重建逻辑会生成（与挂起重启后的修复轮同一条路）
      run.state = {
        ...run.state,
        cursor: 'implement',
        pendingReverify: 'review',
        reviewFixRounds: state.reviewFixRounds + 1,
        haltedReason: undefined,
      };
      run.save();
      appendEvent({ ticket, type: 'resume', stage: 'implement', summary: '仲裁追加修复轮' });
      await port.notify(ticket, '追加修复轮：打回 implement 修复未消化的阻断项…');
      return 'continue';
    }
    if (d.note?.trim()) appendFeedback(repo, ticket, '评审仲裁备注', d.note);
    await port.notify(ticket, `已挂起：${haltedReason}。处理后在群里说「继续 ${ticket}」（会重跑 review）`);
    return 'return';
  }
  // 错误翻译层：不把人丢给一句技术挂起原因，直接给「重试」按钮（本 runner 只发一次，防确定性失败空转）
  if (!run.offeredRetry) {
    run.offeredRetry = true;
    appendEvent({ ticket, type: 'gate.asked', stage: state.cursor, summary: '挂起处理卡：是否立即重试' });
    const d = await port.confirmGate(
      ticket,
      '挂起处理',
      `工单在 ${state.cursor} 阶段挂起：${haltedReason.slice(0, 300)}\n\n通过 → 让 AI 立即重试该阶段（备注会作为约束带入）；驳回 → 保持挂起，处理好后在群里说「继续 ${ticket}」`,
      [],
    );
    appendEvent({
      ticket,
      type: 'gate.answered',
      stage: state.cursor,
      summary: `挂起处理 → ${d.approved ? '重试' : '保持挂起'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
    });
    if (d.approved) {
      if (d.note?.trim()) {
        const fb = appendFeedback(repo, ticket, '挂起重试说明', d.note);
        run.extraArgs = `feedback=${fb}`;
      }
      run.state = { ...run.state, haltedReason: undefined };
      run.save();
      await port.notify(ticket, `重试 ${state.cursor} 阶段…`);
      return 'continue';
    }
    if (d.note?.trim()) appendFeedback(repo, ticket, '挂起备注', d.note);
  }
  await port.notify(ticket, `已挂起：${haltedReason}。处理后续跑，或在群里说「继续 ${ticket}」`);
  return 'return';
}
