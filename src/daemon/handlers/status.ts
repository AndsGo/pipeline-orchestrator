import { listTickets, timeline, totalCost } from '../../events.js';
import { loadTicket, peekTicketRepo } from '../../ticket.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'status'>, _sender: string, chat?: string): Promise<void> {
  const { port, active } = ctx;
  const t = c.ticket ?? [...active.keys()][0] ?? listTickets().at(-1);
  if (!t) {
    await port.notify('状态', '还没有工单');
    return;
  }
  const repo = peekTicketRepo(t);
  const st = repo ? loadTicket(repo, t, 'clarify') : null;
  const extra = [
    `**通道：** ${st?.lane ?? '?'}　**在跑：** ${active.has(t) ? '是' : '否'}`,
    `**成本：** $${totalCost(t).toFixed(2)}　**回环：** review ${st?.reviewFixRounds ?? 0} / 验收 ${st?.acceptanceFixRounds ?? 0}`,
    st?.haltedReason ? `**挂起原因：** ${st.haltedReason}` : '',
    st?.isWorktree ? `**工作区：** ${st.repo}（隔离）` : '',
  ]
    .filter(Boolean)
    .join('\n');
  await port.sendStatus(t, st?.cursor ?? '未知', extra, timeline(t, 20), chat);
}
