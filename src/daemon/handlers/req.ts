import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';
import { startReq } from '../reqFlow.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'req'>, sender: string, chat?: ChatRef): Promise<void> {
  const text = c.text.replace(/^\/req\s*/i, '').trim();
  if (!text) {
    await ctx.port.notify('需求', '「/req」后面写一句你想要什么，例如：/req 数据域里想一眼看出哪些表没设权限', chat);
    return;
  }
  await startReq(ctx, text, sender, chat, c.project);
}
