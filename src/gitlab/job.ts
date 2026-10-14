import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { engineFor } from '../engine/index.js';
import { buildReviewPrompt, formatComment, MR_REVIEW_SCHEMA, type GitlabConfig, type MrNoteEvent, type MrReviewResult } from './core.js';

const REVIEW_MODEL = 'opus';
const REVIEW_BUDGET = 10;

function api(cfg: GitlabConfig, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  return fetch(`${cfg.url}/api/v4${pathAndQuery}`, {
    ...init,
    headers: { 'PRIVATE-TOKEN': cfg.apiToken, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

/** MR 评论触发的独立 review：fetch MR head → 临时 worktree → claude 评审 → 回帖 → 清理 */
export async function runMrReview(cfg: GitlabConfig, ev: MrNoteEvent, repo: string, log: (m: string) => void): Promise<void> {
  const engine = engineFor(repo, 'mr-review');
  const proj = encodeURIComponent(ev.projectPath);

  // diff 基点从 MR 的 diff_refs 取（与 GitLab 展示口径一致）
  const mrRes = await api(cfg, `/projects/${proj}/merge_requests/${ev.mrIid}`);
  if (!mrRes.ok) throw new Error(`取 MR 信息失败：HTTP ${mrRes.status}`);
  const mr = (await mrRes.json()) as { diff_refs?: { base_sha?: string; head_sha?: string } };
  const baseSha = mr.diff_refs?.base_sha;
  const headSha = mr.diff_refs?.head_sha;
  if (!baseSha || !headSha) throw new Error('MR diff_refs 缺失（可能尚无提交）');

  sh(`git fetch origin "+refs/merge-requests/${ev.mrIid}/head:refs/pipeline/mr-${ev.mrIid}"`, repo);

  const wt = path.join(repo, `.mr-review-${ev.mrIid}`);
  removeWorktree(repo, wt); // 上一轮可能留下残缺目录（Windows 文件锁），先硬清理
  sh(`git worktree add --detach "${wt}" ${headSha}`, repo);

  try {
    const diffFile = path.join(wt, '.mr-diff.txt');
    fs.writeFileSync(diffFile, sh(`git diff ${baseSha}...${headSha}`, wt), 'utf-8');
    log(`MR !${ev.mrIid} diff 就绪（base ${baseSha.slice(0, 7)}），启动评审会话`);

    const { envelope } = await engine.runJson({ cwd: wt, prompt: buildReviewPrompt(ev, '.mr-diff.txt'), tools: 'Read,Grep,Glob,Bash', model: REVIEW_MODEL, maxTurns: 80, budgetUsd: REVIEW_BUDGET, schema: MR_REVIEW_SCHEMA });
    const result = envelope.structured_output as unknown as MrReviewResult;
    log(`评审完成：${result.verdict}，findings ${result.findings.length} 条`);

    const noteRes = await api(cfg, `/projects/${proj}/merge_requests/${ev.mrIid}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body: formatComment(result, cfg.trigger) }),
    });
    if (!noteRes.ok) throw new Error(`回帖失败：HTTP ${noteRes.status}`);
    log(`已回帖到 MR !${ev.mrIid}`);
  } finally {
    removeWorktree(repo, wt);
  }
}

/** Windows 下 worktree remove 可能因文件锁失败并留下残缺目录：三段式硬清理 */
function removeWorktree(repo: string, wt: string): void {
  if (!fs.existsSync(wt)) return;
  try {
    sh(`git worktree remove --force "${wt}"`, repo);
  } catch {
    /* 残缺目录不是合法 worktree，转硬删除 */
  }
  try {
    fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch {
    /* 仍被锁住：留给下一轮 pre-clean */
  }
  try {
    sh('git worktree prune', repo);
  } catch {
    /* prune 失败无碍 */
  }
}
