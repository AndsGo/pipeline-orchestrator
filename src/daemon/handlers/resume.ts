import { appendEvent } from '../../events.js';
import { clearPaused } from '../../pause.js';
import { peekTicketRepo, readSnapshot, saveTicket } from '../../ticket.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'resume'>, sender: string): Promise<void> {
  clearPaused(c.ticket);
  // 挂起工单的「继续」= 人已处理挂起原因。不清标记的话重进即再挂，人陷入死循环
  const halted = readSnapshot(c.ticket);
  if (halted?.haltedReason) saveTicket({ ...halted, haltedReason: undefined });
  appendEvent({ ticket: c.ticket, type: 'resume', summary: `收到继续指令（by ${sender}）` });
  const repo = peekTicketRepo(c.ticket);
  await ctx.port.notify(c.ticket, await ctx.startTicket(c.ticket, repo ?? undefined));
}
