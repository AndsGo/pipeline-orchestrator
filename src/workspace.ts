import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 并行工作区：同一仓库的多个工单必须物理隔离，否则两个 implement 会互相踩。
 * 第一个工单直接用主仓库；后续并发工单各自开 git worktree。
 */

export interface Workspace {
  /** 工单实际工作目录（主仓库或 worktree） */
  workdir: string;
  isWorktree: boolean;
  baseRef: string;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** 解析新工单的基线：优先 origin 默认分支，避免从别的工单未合并的分支上分叉 */
export function resolveBaseRef(mainRepo: string): string {
  const explicit = process.env.PIPELINE_BASE_REF;
  if (explicit) return explicit;
  for (const cand of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    try {
      const ref = sh(`git rev-parse --abbrev-ref ${cand}`, mainRepo);
      if (ref && !ref.includes('fatal')) return ref;
    } catch {
      /* 试下一个 */
    }
  }
  return sh('git rev-parse --abbrev-ref HEAD', mainRepo);
}

export function worktreePath(mainRepo: string, ticket: string): string {
  return path.resolve(mainRepo, '..', `${path.basename(mainRepo)}-wt-${ticket}`);
}

/**
 * 分配工作区。busy=true 表示主仓库已被其他在跑的工单占用 → 开 worktree。
 * 已存在的 worktree 直接复用（断点续跑场景）。
 */
export function allocateWorkspace(mainRepo: string, ticket: string, busy: boolean): Workspace {
  const wt = worktreePath(mainRepo, ticket);
  if (fs.existsSync(wt)) {
    return { workdir: wt, isWorktree: true, baseRef: '(既有 worktree)' };
  }
  if (!busy) return { workdir: mainRepo, isWorktree: false, baseRef: '(主仓库)' };

  const baseRef = resolveBaseRef(mainRepo);
  sh(`git worktree add --detach "${wt}" ${baseRef}`, mainRepo);
  return { workdir: wt, isWorktree: true, baseRef };
}

/** 工单结束后可选清理（默认保留：分支上的提交还要给人看/合并） */
export function releaseWorkspace(mainRepo: string, ws: Workspace): void {
  if (!ws.isWorktree) return;
  try {
    sh(`git worktree remove --force "${ws.workdir}"`, mainRepo);
  } catch {
    /* 有未提交内容或被占用：保留现场，交人处理 */
  }
}
