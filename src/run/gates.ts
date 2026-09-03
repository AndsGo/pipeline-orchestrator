import { gateDetail } from '../artifacts.js';
import { appendEvent } from '../events.js';
import { appendFeedback } from '../feedback.js';
import { GATE_SOURCE } from '../machine.js';
import type { TicketState } from '../types.js';
import type { TicketRun } from './context.js';

/** 弹卡点并落地答复。卡在 state.pendingGate 里持久化到答复为止——重启后重发这张卡，而不是跳过它 */
export async function askGate(run: TicketRun, g: NonNullable<TicketState['pendingGate']>): Promise<void> {
  const { repo, ticket, port } = run;
  appendEvent({ ticket, type: 'gate.asked', stage: g.stage, summary: `卡点 ${g.gate} 等待人工` });
  const d = await port.confirmGate(ticket, g.gate, g.summary, g.concerns, gateDetail(g.gate, repo, ticket));
  appendEvent({
    ticket,
    type: 'gate.answered',
    stage: g.stage,
    summary: `卡点 ${g.gate} → ${d.approved ? '通过' : '驳回'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
  });
  run.state = { ...run.state, pendingGate: undefined };
  if (!d.approved) {
    const back = GATE_SOURCE[g.gate] ?? 'halt';
    const fbPath = appendFeedback(repo, ticket, `${g.gate} 驳回`, d.note ?? '（未填写原因）');
    if (back === 'halt') {
      run.state = { ...run.state, haltedReason: `${g.gate} 驳回：${d.note ?? '未填写原因'}` };
    } else {
      // 驳回不是终止，而是带着人的意见重跑产出这份材料的阶段
      run.state = { ...run.state, pendingRewind: { to: back, reason: `${g.gate} 驳回`, feedbackPath: fbPath } };
    }
  } else if (d.note?.trim()) {
    appendFeedback(repo, ticket, `${g.gate} 通过备注`, d.note);
  }
  run.save();
}

/** 重启前弹出、没等到答复的卡点：原样重发。游标早已推到下一阶段，不拦在这里就等于人没审批直接开工 */
export async function reaskPendingGate(run: TicketRun, g: NonNullable<TicketState['pendingGate']>): Promise<void> {
  await run.port.notify(run.ticket, `重启前的 ${g.gate} 卡未得到答复，原样重发（${g.stage} 阶段产物未变，不重跑）`);
  await askGate(run, g);
}
