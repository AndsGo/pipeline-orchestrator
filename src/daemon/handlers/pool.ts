import { listReqs, renderPool } from '../../requirements.js';
import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, _c: CommandOf<'pool'>, _sender: string, chat?: ChatRef): Promise<void> {
  // 空池的正文已经带着 /req 用法，页脚只指看板，不重复
  await ctx.port.sendResult('需求池', renderPool(listReqs()), '完整列表与需求说明在多维表格「需求池」表', chat);
}
