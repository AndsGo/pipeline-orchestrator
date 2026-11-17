import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';
import { handleBug } from '../bugFlow.js';

export async function handle(ctx: DaemonContext, command: CommandOf<'bug'>, actor: string, chat?: ChatRef): Promise<void> {
  await handleBug(ctx, command.text.replace(/^\/bug\s*/i, '').trim(), actor, chat, command);
}
