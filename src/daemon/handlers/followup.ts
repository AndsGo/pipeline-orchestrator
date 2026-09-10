import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'followup'>, _sender: string, chat?: ChatRef): Promise<void> {
  await ctx.runFollowup(c.text, chat, c.quotedMessageId);
}
