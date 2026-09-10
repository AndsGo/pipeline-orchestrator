import { helpText } from '../../commands.js';
import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, _c: CommandOf<'help'>, _sender: string, chat?: ChatRef): Promise<void> {
  await ctx.port.notify('指令', helpText(), chat);
}
