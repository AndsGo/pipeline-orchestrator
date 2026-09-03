import { appendEvent } from '../../events.js';
import { setPaused } from '../../pause.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'pause'>, sender: string): Promise<void> {
  setPaused(c.ticket, sender);
  appendEvent({ ticket: c.ticket, type: 'pause', summary: `收到暂停指令（by ${sender}）` });
  await ctx.port.notify(c.ticket, '已登记暂停：当前阶段跑完即停（不会打断进行中的会话）');
}
