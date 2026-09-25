import fs from 'node:fs';
import path from 'node:path';
import { applyEnvReload, parseEnvText } from '../envKeys.js';
import { appendEvent, listTickets } from '../events.js';
import { clearPaused } from '../pause.js';
import { loadProjects } from '../projects.js';
import { listReqs } from '../requirements.js';
import { peekTicketRepo, readSnapshot, saveTicket } from '../ticket.js';
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
/**
 * 正在处理中的群消息数（收到 → 分类 → 分发完毕）。分类要十几秒，这期间闸门还没被占：
 * 2026-09-11 真机——同事一句 @ 到达 0.8 秒后 daemon 按「无会话在执行」退出，这句丢了
 */
export const inflight = { n: 0 };

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
    if (sem.inUse > 0 || inflight.n > 0) {
      if (!stopDeferredLogged) {
        stopDeferredLogged = true;
        log(`收到停止信号，但有 ${sem.inUse} 个阶段会话在执行、${inflight.n} 条消息在处理，等它们结束再退出`);
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

/**
 * 运行态心跳（控制台读源）：闸门占用、在跑工单、待答卡片只存在于本进程内存，控制台是另一个进程，
 * 只能靠这份 10 秒一写的快照看到。写临时文件再 rename，读方不会读到半截。
 */
export interface RuntimeSnapshot {
  pid: number;
  startedAt: number;
  at: number;
  concurrency: { inUse: number; max: number; waiting: number };
  active: string[];
  /** 等人答的卡片标签，按工单/需求分组 */
  pending: Record<string, string[]>;
  adhoc: { count: number; cost: number };
  boardOn: boolean;
  projects: string[];
}

export function runtimeSnapshot(ctx: DaemonContext, now = Date.now()): RuntimeSnapshot {
  const pending: Record<string, string[]> = {};
  let grouped = 0;
  for (const t of new Set([...ctx.active.keys(), ...listTickets(), ...listReqs().map((r) => r.id)])) {
    const labels = ctx.port.pendingLabels(t);
    if (!labels.length) continue;
    pending[t] = labels;
    grouped += labels.length;
  }
  const all = ctx.port.pendingLabels().length;
  if (all > grouped) pending['（其他）'] = [`${all - grouped} 张`];
  return {
    pid: process.pid,
    startedAt: ctx.startedAt,
    at: now,
    concurrency: { inUse: ctx.sem.inUse, max: ctx.cfg.maxConcurrency, waiting: ctx.sem.waiting },
    active: [...ctx.active.keys()],
    pending,
    adhoc: { count: ctx.adhoc.length, cost: ctx.adhoc.reduce((a, x) => a + x.costUsd, 0) },
    boardOn: ctx.boardOn,
    projects: ctx.projects.map((p) => p.alias),
  };
}

export function startHeartbeat(ctx: DaemonContext, file: string): void {
  const tick = (): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(runtimeSnapshot(ctx)), 'utf-8');
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      ctx.log(`心跳落盘失败：${(e as Error).message.slice(0, 120)}`);
    }
  };
  tick();
  setInterval(tick, 10_000);
}

/**
 * 控制台信号（控制台进程与 daemon 之间只有文件）：
 * - data/env.reload：控制台改完 .env 后写；这里整份重读，热键覆盖 process.env，项目表原地替换，冻结键只记名。
 *   与 /bind、/addproject 同源：它们改的也是这份 .env，重读得到的值与内存一致。
 * - data/console.queue.jsonl：控制台发起的动作（目前只有 resume——恢复要起 runner，写个暂停文件办不到）。
 *   读完即清空；每条动作的结果照常发群，群里的人看得见是谁从哪里发起的。
 */
export function startConsoleSignals(ctx: DaemonContext, files: { reload: string; queue: string }): void {
  const { log } = ctx;
  setInterval(() => {
    if (fs.existsSync(files.reload)) {
      fs.rmSync(files.reload, { force: true });
      try {
        const parsed = parseEnvText(fs.readFileSync(ctx.envFile, 'utf-8'));
        const before = process.env.PIPELINE_PROJECTS;
        const r = applyEnvReload(parsed);
        if (process.env.PIPELINE_PROJECTS !== before) ctx.projects.splice(0, ctx.projects.length, ...loadProjects());
        log(`控制台热重载 .env：生效 ${r.applied.length ? r.applied.join('、') : '无'}${r.deferred.length ? `；需重启才生效 ${r.deferred.join('、')}` : ''}`);
      } catch (e) {
        log(`控制台热重载失败：${(e as Error).message.slice(0, 160)}`);
      }
    }
    if (!fs.existsSync(files.queue)) return;
    let lines: string[];
    try {
      lines = fs.readFileSync(files.queue, 'utf-8').split('\n').filter(Boolean);
      fs.rmSync(files.queue, { force: true });
    } catch {
      return;
    }
    for (const line of lines) {
      let cmd: { kind?: string; ticket?: string; by?: string };
      try {
        cmd = JSON.parse(line) as typeof cmd;
      } catch {
        continue;
      }
      if (cmd.kind === 'resume' && cmd.ticket) void resumeFromConsole(ctx, cmd.ticket, cmd.by ?? '控制台');
      else log(`控制台队列里有不认识的动作：${line.slice(0, 80)}`);
    }
  }, 10_000);
}

async function resumeFromConsole(ctx: DaemonContext, ticket: string, by: string): Promise<void> {
  clearPaused(ticket);
  const halted = readSnapshot(ticket);
  if (halted?.haltedReason) saveTicket({ ...halted, haltedReason: undefined });
  appendEvent({ ticket, type: 'resume', summary: `收到继续指令（by ${by}，控制台）` });
  try {
    await ctx.port.notify(ticket, await ctx.startTicket(ticket, peekTicketRepo(ticket) ?? undefined));
  } catch (e) {
    ctx.log(`控制台恢复 ${ticket} 失败：${(e as Error).message.slice(0, 160)}`);
  }
}
