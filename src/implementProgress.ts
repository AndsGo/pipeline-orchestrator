import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';

/**
 * implement 分批续做的进展判据。
 *
 * 由来（LS-012，2026-08-21）：计划含 9 个任务、正文 4084 行，implement 连续两次会话分别止于
 * Task 1 与 Task 2，两次都不是技术障碍也不缺业务信息——是单次会话的执行余量装不下 9 个任务。
 * 会话自己给的解法是「分批调起」，但当时每批都要人在群里说一次「继续 LS-012」才能往下走。
 * 这里把「还有未完成任务 + 上一轮确实有进展」变成可判定的条件，让编排器自动续跑下一批。
 */

/** 计划里的任务总数：`### Task N: 标题` */
export function countPlanTasks(planText: string): number {
  const ids = new Set<string>();
  for (const m of planText.matchAll(/^###\s+Task\s+(\d+)\s*[:：]/gm)) ids.add(m[1]);
  return ids.size;
}

/**
 * 台账里已完成的任务数：`- Task N: complete`。
 * 只认 complete 行——「implementation complete, review pending」那种半成品不算完成
 * （LS-012 的 Task 2 正是这个状态：实现已提交但任务评审没跑）。
 */
export function countLedgerDone(ledgerText: string): number {
  const ids = new Set<string>();
  for (const m of ledgerText.matchAll(/^-\s*Task\s+(\d+)\s*[:：]\s*complete\b/gim)) ids.add(m[1]);
  return ids.size;
}

export interface ImplementProgress {
  done: number;
  total: number;
  /** 台账行数：任务未整块完成时的细粒度进展信号（评审补跑、fix round 都只加行不加 complete） */
  ledgerLines: number;
}

export function readImplementProgress(repo: string, ticket: string): ImplementProgress {
  const dir = ticketDir(repo, ticket);
  const read = (f: string): string => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf-8');
    } catch {
      return '';
    }
  };
  const ledger = read('ledger.md');
  return {
    done: countLedgerDone(ledger),
    total: countPlanTasks(read('20-plan.md')),
    ledgerLines: ledger ? ledger.split('\n').length : 0,
  };
}

export interface AutoContinueDecision {
  ok: boolean;
  reason: string;
}

/**
 * 是否自动续跑下一批。四个否决点，任一命中就转人工：
 * 1. 拿不到任务总数（计划文件缺失/格式变了）——判不出还剩多少，不猜。
 * 2. 任务已全部完成——挂起原因另有其事，自动重试只会重复失败。
 * 3. 已用满续跑次数——防止一直续到天亮。
 * 4. 上一轮台账零增长——确定性失败的空转特征（真缺信息、环境坏了都长这样）。
 */
export function decideAutoContinue(opts: {
  before?: ImplementProgress;
  now: ImplementProgress;
  used: number;
  cap: number;
}): AutoContinueDecision {
  const { before, now, used, cap } = opts;
  if (now.total <= 0) return { ok: false, reason: '读不到计划的任务总数，无法判断是否还有未完成任务' };
  if (now.done >= now.total) return { ok: false, reason: `${now.total} 个任务已全部完成，挂起另有原因` };
  if (used >= cap) return { ok: false, reason: `已自动续跑 ${cap} 批仍未做完（当前 ${now.done}/${now.total}），转人工` };
  if (!before) return { ok: false, reason: '本进程没有上一轮进展基线，不自动续跑' };
  if (now.done <= before.done && now.ledgerLines <= before.ledgerLines) {
    return { ok: false, reason: `上一轮台账零增长（仍 ${now.done}/${now.total}），不像执行余量不足，转人工` };
  }
  return {
    ok: true,
    reason: `已完成 ${now.done}/${now.total} 个任务，自动续跑第 ${used + 1}/${cap} 批`,
  };
}
