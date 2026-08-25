import { execSync } from 'node:child_process';
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

/**
 * 本工单的工件目录候选：主工作区 + 名字或分支带工单号的 git worktree。
 *
 * implement 会自己 `git worktree add` 另开工作区干活（LS-012 的开工前 ruling 正是如此，
 * 理由是主工作区有别人的未提交内容），台账与计划随之落在 worktree 里，主工作区那份是旧的。
 * 实测代价（2026-08-21 12:39）：判据只看主工作区 → 台账 137 行 / 1 个任务完成，
 * 而 worktree 里已是 538 行 / 8 个任务完成，于是被判成「零增长」不续跑，人又去点了一次重试卡。
 */
export function ticketArtifactDirs(repo: string, ticket: string): string[] {
  const dirs = [ticketDir(repo, ticket)];
  try {
    const out = execSync('git worktree list --porcelain', { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const block of out.split(/\n\s*\n/)) {
      const wt = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
      const branch = /^branch (.+)$/m.exec(block)?.[1]?.trim() ?? '';
      if (!wt) continue;
      const same = path.resolve(wt) === path.resolve(repo);
      if (!same && (wt.includes(ticket) || branch.includes(ticket))) dirs.push(ticketDir(wt, ticket));
    }
  } catch {
    /* 非 git 仓库 / git 不可用：只看主工作区 */
  }
  return dirs;
}

/**
 * 探测本工单的真实分支名。
 *
 * 分支名由实现会话按计划的 Global Constraints 自己取（`feat/<工单号>-<slug>`，
 * 如 feat/LS-012-org-call-monitor），编排器事先猜不出来，只能事后认。
 * 优先本地分支：远端的会随 MR 合并被删除（实测 LS-012 的远端分支合并后即消失）。
 */
export function detectTicketBranch(repo: string, ticket: string): string | undefined {
  const list = (args: string): string[] => {
    try {
      return execSync(`git branch ${args} --format=%(refname:short)`, {
        cwd: repo,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const local = list(`--list *${ticket}*`);
  if (local.length) return local[0];
  // 远端候选去掉 origin/ 前缀：看板要显示的是分支名，不是 remote-tracking 引用名
  const remote = list(`-r --list *${ticket}*`).map((b) => b.replace(/^[^/]+\//, ''));
  if (remote.length) return remote[0];
  // 分支已随 MR 合并被删除时的恢复路径：合并提交的标题里留着原分支名。
  // 正常流程用不到（implement 刚跑完时分支还在），它是为了让几个月后回看旧工单仍有答案。
  try {
    const subjects = execSync(`git log --merges --grep=${ticket} --format=%s -n 20`, {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of subjects.split(/\r?\n/)) {
      const m = /Merge branch '([^']+)'/.exec(line);
      if (m?.[1]?.includes(ticket)) return m[1];
    }
  } catch {
    /* 非 git 仓库 / 无合并历史 */
  }
  return undefined;
}

function readOne(dir: string): ImplementProgress {
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

/** 取进展最靠前的那份工件（主工作区与 worktree 各有一份台账时，干活的那份才是真相） */
export function readImplementProgress(repo: string, ticket: string): ImplementProgress {
  return ticketArtifactDirs(repo, ticket)
    .map(readOne)
    .reduce((best, cur) => {
      if (cur.done !== best.done) return cur.done > best.done ? cur : best;
      if (cur.ledgerLines !== best.ledgerLines) return cur.ledgerLines > best.ledgerLines ? cur : best;
      return cur.total > best.total ? cur : best;
    });
}

/** implement 期间要盯的台账文件：worktree 里那份优先（行多者为准），拿不到就退回主工作区 */
export function resolveLedgerFile(repo: string, ticket: string): string {
  const files = ticketArtifactDirs(repo, ticket).map((d) => path.join(d, 'ledger.md'));
  let best = files[0];
  let bestLines = -1;
  for (const f of files) {
    try {
      const n = fs.readFileSync(f, 'utf-8').split('\n').length;
      if (n > bestLines) {
        best = f;
        bestLines = n;
      }
    } catch {
      /* 该候选没有台账 */
    }
  }
  return best;
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
