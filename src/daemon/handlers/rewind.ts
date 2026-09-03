import { appendEvent } from '../../events.js';
import { appendFeedback } from '../../feedback.js';
import { peekTicketRepo } from '../../ticket.js';
import { scheduleRewind } from '../../ticketRunner.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'rewind'>, sender: string): Promise<void> {
  const { port, active } = ctx;
  const repo = peekTicketRepo(c.ticket);
  if (!repo) {
    await port.notify(c.ticket, '工单不存在');
    return;
  }
  const fb = c.reason ? appendFeedback(repo, c.ticket, `回退到 ${c.stage}`, c.reason, sender) : undefined;
  scheduleRewind(repo, c.ticket, c.stage, c.reason ?? '人工回退', fb);
  appendEvent({ ticket: c.ticket, type: 'rewind', stage: c.stage, summary: `登记回退到 ${c.stage}` });
  await port.notify(
    c.ticket,
    active.has(c.ticket)
      ? `已登记回退到 ${c.stage}：当前阶段跑完后生效`
      : `已登记回退到 ${c.stage}。${await ctx.startTicket(c.ticket, repo)}`,
  );
}
