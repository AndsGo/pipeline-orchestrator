import { listReqs, renderPool } from '../../requirements.js';
import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, _c: CommandOf<'pool'>, _sender: string, chat?: ChatRef): Promise<void> {
  await ctx.port.sendResult('需求池', renderPool(listReqs()), '提需求：/req 一句话说想要什么；需求池表在多维表格「需求池」', chat);
}
