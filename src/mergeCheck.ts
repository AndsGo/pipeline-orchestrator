import { spawnSync } from 'node:child_process';

/**
 * 合并前的冲突预检：先拉目标分支最新代码，再用 `git merge-tree --write-tree` 干跑一次合并（不动工作区、不产生提交）。
 * 有冲突就把文件名列出来交给人；干净才让编排器去合。用户要求（2026-09-03）：「合并到目标分支时需要先拉取目标分支
 * 的最新代码，检查合并是否存在冲突」。
 * 需要 git ≥ 2.38；更老的 git 返回 unchecked，调用方照旧合并但在卡上明说没检查。
 */
export type MergeCheck =
  | { ok: true; targetSha: string; upToDate: boolean }
  | { ok: false; conflicts: string[]; targetSha: string }
  | { ok: 'unchecked'; reason: string };

function git(cwd: string, args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function checkMergeAgainstTarget(repo: string, branch: string, target: string, remote = 'origin'): MergeCheck {
  const fetch = git(repo, ['fetch', '--quiet', remote, target]);
  if (fetch.status !== 0) return { ok: 'unchecked', reason: `无法拉取 ${remote}/${target}：${fetch.err.trim().slice(0, 160) || '远端不可达'}` };
  const ref = `${remote}/${target}`;
  const sha = git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  if (sha.status !== 0) return { ok: 'unchecked', reason: `${ref} 不存在` };
  const targetSha = sha.out.trim();
  // 目标分支已包含在工单分支里（刚从最新 target 切出、或已经 merge 过）→ 直接干净
  if (git(repo, ['merge-base', '--is-ancestor', ref, branch]).status === 0) return { ok: true, targetSha, upToDate: true };
  const mt = git(repo, ['merge-tree', '--write-tree', '--name-only', ref, branch]);
  if (mt.status === 0) return { ok: true, targetSha, upToDate: false };
  if (mt.status === 1) {
    // 输出：第一行树 OID，随后每行一个冲突文件，空行之后是给人看的说明（--name-only 也照样打印），只取空行之前
    const lines = mt.out.split('\n').slice(1);
    const end = lines.findIndex((l) => l.trim() === '');
    const conflicts = (end === -1 ? lines : lines.slice(0, end)).map((l) => l.trim()).filter(Boolean);
    return { ok: false, conflicts, targetSha };
  }
  return { ok: 'unchecked', reason: `merge-tree 不可用（git ≥ 2.38 才支持）：${mt.err.trim().slice(0, 160)}` };
}

/** 卡片/日志里的一句话 */
export function describeMergeCheck(c: MergeCheck, target: string): string {
  if (c.ok === 'unchecked') return `未能检查与 ${target} 的冲突（${c.reason}），合并前请自行确认`;
  if (c.ok) return `与 origin/${target} 最新代码（${c.targetSha.slice(0, 8)}）${c.upToDate ? '已同步' : '无冲突'}`;
  return `⚠ 与 origin/${target} 最新代码（${c.targetSha.slice(0, 8)}）有冲突，${c.conflicts.length} 个文件：${c.conflicts.slice(0, 8).join('、')}${c.conflicts.length > 8 ? '…' : ''}`;
}
