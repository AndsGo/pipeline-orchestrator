import { helpText, nearestSlash } from '../../commands.js';
import { describeLastRun, readLastRunFor } from '../../followup.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'unknown'>, _sender: string, chat?: string): Promise<void> {
  const { port } = ctx;
  // 斜杠命令拼错：给最接近的候选，把「名字打错」和「真没这个命令」区分开（/dashborad 实测，2026-09-01）
  if (c.text.trim().startsWith('/')) {
    const typo = c.text.trim().slice(1).split(/\s+/)[0];
    const near = nearestSlash(typo);
    if (near) {
      await port.notify('指令', `没有 \`/${typo}\`，你是不是想说 \`/${near}\`？`, chat);
      return;
    }
  }
  // 落空兜底：这句可能是在回复上一次 /run 的收尾问题（实测被判成 answer 后因无待答卡石沉大海）。
  // 以斜杠开头的不算——那是命令格式打错了，不是在回话
  const last = c.text.trim().startsWith('/') ? null : readLastRunFor(chat);
  if (last) {
    const CONT = '是，接着办';
    const pick = await port.chooseOption(
      '执行',
      `现在没有待回答的卡片，这句我也没听懂：\n> ${c.text.slice(0, 120)}\n\n你是不是在回复刚才的执行结果 ${describeLastRun(last)}？`,
      [CONT, '不是，忽略这句'],
      chat,
    );
    if (pick === CONT) {
      await ctx.runFollowup(c.text, chat);
      return;
    }
    await port.notify('指令', '好，这句已忽略。要下指令可用斜杠命令（/help 看用法）。', chat);
    return;
  }
  await port.notify('指令', `没听懂「${c.text.slice(0, 60)}」。\n${helpText()}`, chat);
}
