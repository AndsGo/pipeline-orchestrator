import { appendEvent } from '../../events.js';
import { appendFeedback, appendRequirementAmendment } from '../../feedback.js';
import { peekTicketRepo } from '../../ticket.js';
import { scheduleRewind } from '../../ticketRunner.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'amend'>, sender: string): Promise<void> {
  const { port, active } = ctx;
  const repo = peekTicketRepo(c.ticket);
  if (!repo) {
    await port.notify(c.ticket, '工单不存在');
    return;
  }
  appendRequirementAmendment(repo, c.ticket, c.text, sender);
  const fb = appendFeedback(repo, c.ticket, '需求变更', c.text, sender);
  scheduleRewind(repo, c.ticket, 'clarify', '需求变更', fb);
  appendEvent({ ticket: c.ticket, type: 'amend', summary: `需求变更：${c.text.slice(0, 80)}` });
  await port.notify(
    c.ticket,
    active.has(c.ticket)
      ? '需求变更已记录：当前阶段跑完后自动回到澄清重跑'
      : `需求变更已记录。${await ctx.startTicket(c.ticket, repo)}`,
  );
}
