import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_SETTINGS } from '../config.js';
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

    const result = await runClaudeReview(wt, buildReviewPrompt(ev, '.mr-diff.txt'));
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

function runClaudeReview(cwd: string, prompt: string): Promise<MrReviewResult> {
  const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const schemaFile = path.join(cwd, '.mr-review-schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(MR_REVIEW_SCHEMA), 'utf-8');
  const args = [
    'claude',
    '-p',
    shq(prompt),
    '--settings',
    shq(RUNNER_SETTINGS.replace(/\\/g, '/')),
    '--output-format',
    'json',
    '--allowedTools',
    shq('Read,Grep,Glob,Bash'),
    '--model',
    REVIEW_MODEL,
    '--max-turns',
    '80',
    '--max-budget-usd',
    String(REVIEW_BUDGET),
    '--json-schema',
    `"$(cat ${shq(schemaFile.replace(/\\/g, '/'))})"`,
  ].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    child.on('error', reject);
    child.on('close', () => {
      try {
        const start = out.indexOf('{"');
        const envelope = JSON.parse(out.slice(start)) as { structured_output?: MrReviewResult; result?: string };
        if (!envelope.structured_output) throw new Error(envelope.result ?? '无结构化返回');
        resolve(envelope.structured_output);
      } catch (e) {
        reject(new Error(`评审会话解析失败：${(e as Error).message}`));
      } finally {
        try {
          fs.unlinkSync(schemaFile);
        } catch {
          /* 已随 worktree 清理 */
        }
      }
    });
  });
}
