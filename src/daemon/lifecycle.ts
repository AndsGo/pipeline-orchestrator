import fs from 'node:fs';
import { BitableBoard } from '../bitable/client.js';
import { lastHitByTitle } from '../hits.js';
import { agingSummary, dueForAudit, readAuditStamp, writeAuditStamp } from '../kbAudit.js';
import type { DaemonContext } from './context.js';

/** daemon 的常驻定时任务：知识库老化审计、停止信号轮询 */

/**
 * 知识库月度老化审计：制度化而不是指望人记得跑脚本（kb-refresh-audit.ts 躺了一周没人跑）。
 * 零成本（只读表+命中日志），到期自动发群；花钱的深检仍由人手动跑脚本
 */
export function startKbAudit(ctx: DaemonContext): void {
  const { port, log } = ctx;
  async function kbAuditTick(): Promise<void> {
    if (!dueForAudit(readAuditStamp(), Date.now())) return;
    const board = BitableBoard.fromEnv();
    if (!board) return; // 未配知识表，无从审计
    try {
      await port.notify('知识库', agingSummary(await board.listKnowledge(), lastHitByTitle('knowledge'), Date.now()));
      writeAuditStamp();
      log('知识库老化审计已发群（下次约 30 天后）');
    } catch (e) {
      log(`知识库老化审计失败（明天再试）：${(e as Error).message.slice(0, 160)}`);
    }
  }
  void kbAuditTick();
  setInterval(() => void kbAuditTick(), 24 * 3600 * 1000);
}

/**
 * 空闲自退（停止信号文件）：看门狗计划任务拉起的 daemon 是提权进程，普通 shell 杀不动、连命令行都看不见
 * （2026-09-02 实测：任务改成 Limited 照样是 High）。改成约定：start-daemon.ps1 -Stop 杀不动就写
 * data/daemon.stop，daemon 每 10 秒看一眼，没有工单在跑或等卡片时自己退出，看门狗 2 分钟内以最新代码拉起。
 * 启动即清掉残留的信号文件，否则新进程一起来就自杀、无限循环。
 */
export function startStopFilePoller(ctx: DaemonContext, stopFile: string): void {
  const { sem, active, log } = ctx;
  fs.rmSync(stopFile, { force: true });
  let stopDeferredLogged = false;
  let stopSeenAt = 0;
  setInterval(() => {
    if (!fs.existsSync(stopFile)) return;
    if (!stopSeenAt) stopSeenAt = Date.now();
    // 「空闲」= 没有会话在执行。等卡片的工单不算：卡片可恢复（卡点卡原样重发、问题卡由「继续」重问），
    // 而一张几天没人答的上线后补验卡不该让 daemon 永远停不下来（2026-09-03 实测）
    if (sem.inUse > 0) {
      if (!stopDeferredLogged) {
        stopDeferredLogged = true;
        log(`收到停止信号，但有 ${sem.inUse} 个阶段会话在执行，等它们结束再退出`);
      }
      return;
    }
    // 群里还挂着刚弹的卡（确认/选择/低置信）：给人 5 分钟答完再退——这些卡不可恢复，重启即作废
    // （2026-09-11 真机：话题里一张「我不太确定」卡刚弹出 50 秒 daemon 就重启了，人的话丢了）
    const cards = ctx.port.pendingLabels().length;
    if (cards > 0 && Date.now() - stopSeenAt < 5 * 60_000) {
      if (!stopDeferredLogged) {
        stopDeferredLogged = true;
        log(`收到停止信号，但有 ${cards} 张卡片等人答，最多等 5 分钟再退出`);
      }
      return;
    }
    fs.rmSync(stopFile, { force: true });
    const waiting = [...active.keys()];
    log(`收到停止信号（data/daemon.stop），无会话在执行，自行退出；看门狗会以最新代码拉起${waiting.length ? `。等卡片的工单 ${waiting.join('、')} 的卡将失效，启动时会在群里提示` : ''}`);
    process.exit(0);
  }, 10_000);
}
