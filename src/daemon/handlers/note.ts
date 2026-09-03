import { appendEvent } from '../../events.js';
import { appendFeedback } from '../../feedback.js';
import { peekTicketRepo, readSnapshot } from '../../ticket.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'note'>, sender: string): Promise<void> {
  const { port } = ctx;
  const repo = peekTicketRepo(c.ticket);
  if (!repo) {
    await port.notify(c.ticket, '工单不存在');
    return;
  }
  appendFeedback(repo, c.ticket, '群内补充说明', c.text, sender);
  appendEvent({ ticket: c.ticket, type: 'human.message', summary: `补充说明：${c.text.slice(0, 80)}` });
  // 闭环工单的反馈没有任何后续阶段会读——不提示的话，「请你处理下」会无声地掉进死信（LS-006 实测）
  const snap = readSnapshot(c.ticket);
  const closed = snap?.runs.some((r) => (r.stage === 'compound' || r.stage === 'fast') && r.status === 'DONE');
  await port.notify(
    c.ticket,
    closed
      ? '已记录，但该工单已闭环，本条备注**不会被自动处理**。要改动或修问题请发 /new 新建工单（可在描述里引用本单）'
      : '已记入工单反馈，下一个阶段会读到（不回退）',
  );
}
