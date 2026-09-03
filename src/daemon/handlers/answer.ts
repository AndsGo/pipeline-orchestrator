import type { CommandOf, DaemonContext } from '../context.js';

/**
 * answer 到不了这里：onMessage 在分发前已把它投递给待答卡片，卡片过期则降级为 note / unknown。
 * 原 switch 里没有这个 case（静默落空）；保留同样的空行为，只为让注册表按 kind 穷举
 */
export async function handle(_ctx: DaemonContext, _c: CommandOf<'answer'>): Promise<void> {}
