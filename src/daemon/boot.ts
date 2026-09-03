import { interruptedStage, listTickets, lostPendingCards, readEvents } from '../events.js';
import type { DaemonContext } from './context.js';

/**
 * 中断巡检：上一个 daemon 死掉时正在跑的工单不会自我恢复，必须开机点名（LS-013 教训：静停 13 小时没人知道）。
 * 刚启动时 active 必空，events 判据即事实
 */
export async function announceInterruptedTickets(ctx: DaemonContext): Promise<void> {
  const { port, log } = ctx;
  for (const t of listTickets()) {
    const evs = readEvents(t);
    const stage = interruptedStage(evs);
    if (stage) {
      log(`${t} 上次运行在 ${stage} 阶段被打断，已在群里提示恢复`);
      await port.notify(t, `⚠ 上次运行在 **${stage}** 阶段中途被打断（daemon 重启/崩溃），进度未丢失。发「继续 ${t}」或 /resume ${t} 恢复。`);
      continue;
    }
    // 姊妹盲区（OP-001 实测）：等人工的卡片随进程内存失效，飞书上的旧卡点了只提示过期
    const lost = lostPendingCards(evs);
    if (lost) {
      log(`${t} 重启前的待答卡片已失效（${lost.slice(0, 60)}），已在群里提示`);
      await port.notify(t, `⚠ 重启前的待答卡片已失效（${lost.slice(0, 80)}）——旧卡片点了没用。发「继续 ${t}」：卡点卡会原样重发，问题卡会重新提问；已经说过的内容若已记入反馈会被读到，不用重复。`);
    }
  }
}
