import { listTickets, totalCost } from '../../events.js';
import { loadTicket, peekTicketRepo } from '../../ticket.js';
import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, _c: CommandOf<'list'>, _sender: string, chat?: ChatRef): Promise<void> {
  const rows = listTickets().map((t) => {
    const st = (() => {
      try {
        const repo = peekTicketRepo(t);
        return repo ? loadTicket(repo, t, 'clarify') : null;
      } catch {
        return null;
      }
    })();
    const mark = ctx.active.has(t) ? '🟢在跑' : st?.haltedReason ? '⛔挂起' : '⏹️空闲';
    return `${mark} ${t} @${st?.cursor ?? '?'}　$${totalCost(t).toFixed(2)}`;
  });
  await ctx.port.notify('工单', rows.length ? rows.join('\n') : '暂无工单', chat);
}
