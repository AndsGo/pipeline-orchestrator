import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ticketDir } from './config.js';

/**
 * compound 产出的 92-suggestions.json：结构化的 CLAUDE.md 追加建议 + 流程改进建议。
 * 建议只以散文形式躺在 90-retro.md 里时没有任何消费者（5 个工单 9+ 条建议仅 1 次被手工合入，
 * 同一条环境限制被独立重复发现 7+ 次）——结构化 + 人审卡 + 采纳即合入，是这条断头路的修法。
 */

export const SUGGESTIONS_FILE = '92-suggestions.json';

export interface ClaudeMdSuggestion {
  /** 目标小节标题（如 "## 环境"）；CLAUDE.md 中不存在该小节时在文件末尾新建 */
  section: string;
  /** 要追加的行。完全相同的行已存在时跳过（重跑 compound 不会堆重复） */
  line: string;
  /** 触发本建议的证据，渲染进人审卡片 */
  why?: string;
}

export interface ProcessSuggestion {
  /** 目标 skill（如 pipeline-acceptance） */
  skill: string;
  suggestion: string;
}

export interface Suggestions {
  claudeMd: ClaudeMdSuggestion[];
  process: ProcessSuggestion[];
}

/** 读取建议文件；缺失 = 无建议，格式不合法时返回 error（宁可不发卡也不发脏数据） */
export function readSuggestions(repo: string, ticket: string): { suggestions: Suggestions; error?: string } {
  const empty: Suggestions = { claudeMd: [], process: [] };
  const f = path.join(ticketDir(repo, ticket), SUGGESTIONS_FILE);
  if (!fs.existsSync(f)) return { suggestions: empty };
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as {
      claudeMd?: unknown[];
      process?: unknown[];
    };
    const claudeMd = (Array.isArray(raw.claudeMd) ? raw.claudeMd : []).filter(isClaudeMdSuggestion);
    const process = (Array.isArray(raw.process) ? raw.process : []).filter(isProcessSuggestion);
    return { suggestions: { claudeMd, process } };
  } catch (e) {
    return { suggestions: empty, error: (e as Error).message };
  }
}

function isClaudeMdSuggestion(v: unknown): v is ClaudeMdSuggestion {
  const s = v as ClaudeMdSuggestion;
  return !!s && typeof s.section === 'string' && s.section.trim().startsWith('#') && typeof s.line === 'string' && s.line.trim().length > 0;
}

function isProcessSuggestion(v: unknown): v is ProcessSuggestion {
  const s = v as ProcessSuggestion;
  return !!s && typeof s.skill === 'string' && typeof s.suggestion === 'string' && s.suggestion.trim().length > 0;
}

/** 卡片决策材料：让人不打开仓库就能判断每条建议该不该进 CLAUDE.md */
export function renderSuggestionsDetail(s: Suggestions): string {
  const parts: string[] = [];
  if (s.claudeMd.length) {
    parts.push('**CLAUDE.md 建议（通过即自动合入）**');
    s.claudeMd.forEach((c, i) =>
      parts.push(`${i + 1}. ${c.section} ← ${c.line}${c.why ? `\n   依据：${c.why}` : ''}`),
    );
  }
  if (s.process.length) {
    parts.push('**流程改进建议（需人工改 skill，不自动执行）**');
    s.process.forEach((p, i) => parts.push(`${i + 1}. [${p.skill}] ${p.suggestion}`));
  }
  return parts.join('\n');
}

/**
 * 把已采纳的建议追加进仓库 CLAUDE.md：行追加到目标小节末尾，小节不存在则在文件末尾新建。
 * 不做 diff 套用——模型产出的 unified diff 经常套不上，按小节追加对"项目常识清单"这种形态足够且稳。
 */
export function applyClaudeMdSuggestions(
  repo: string,
  items: ClaudeMdSuggestion[],
): { applied: string[]; skipped: string[] } {
  const file = path.join(repo, 'CLAUDE.md');
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '# CLAUDE.md\n';
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const item of items) {
    const line = item.line.trim();
    const section = item.section.trim();
    const lines = content.split('\n');
    if (lines.some((l) => l.trim() === line)) {
      skipped.push(line);
      continue;
    }
    const headIdx = lines.findIndex((l) => l.trim() === section);
    if (headIdx === -1) {
      content = `${content.replace(/\n*$/, '\n')}\n${section}\n\n${line}\n`;
    } else {
      let end = lines.length;
      for (let i = headIdx + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i])) {
          end = i;
          break;
        }
      }
      let insertAt = end;
      while (insertAt - 1 > headIdx && lines[insertAt - 1].trim() === '') insertAt--;
      lines.splice(insertAt, 0, line);
      content = lines.join('\n');
    }
    applied.push(line);
  }

  if (applied.length) fs.writeFileSync(file, content, 'utf-8');
  return { applied, skipped };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export interface AdoptResult {
  ok: boolean;
  applied: string[];
  skipped: string[];
  /** GitLab push options 建出的 MR 链接（解析自 push 输出） */
  mrUrl?: string;
  /** 分支已推送但远端不支持 push options（需手动建 MR）时给出分支名 */
  pushedBranch?: string;
  error?: string;
}

/**
 * 采纳走「专用分支 + MR」：从 origin 默认分支拉临时 worktree，合入建议、提交、推送并用
 * push options 自动建 MR——保证项目常识永远有一条进主干的路。此前采纳提交落在"恰好检出的分支"上，
 * LS-006~008 的三条采纳曾困在本地旧分支，内容靠分支谱系碰巧才传播到 master。
 * 主工作区全程不被触碰（可能正被别的会话使用）。
 */
export function adoptViaMr(repo: string, ticket: string, items: ClaudeMdSuggestion[]): AdoptResult {
  const branch = `pipeline/claude-md-${ticket}`;
  const wt = path.join(os.tmpdir(), `claude-md-${ticket}`);
  const cleanup = (): void => {
    git(repo, ['worktree', 'remove', '--force', wt]);
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {
      /* 残留目录清不掉也不阻塞 */
    }
    git(repo, ['branch', '-D', branch]);
  };
  try {
    if (!git(repo, ['fetch', 'origin', '--prune']).ok) {
      return { ok: false, applied: [], skipped: [], error: '无法 fetch origin（远端不可达或未配置）' };
    }
    const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    let base = head.ok ? head.out.trim().replace(/^origin\//, '') : '';
    if (!base) {
      base = git(repo, ['rev-parse', '--verify', 'origin/master']).ok
        ? 'master'
        : git(repo, ['rev-parse', '--verify', 'origin/main']).ok
          ? 'main'
          : '';
    }
    if (!base) return { ok: false, applied: [], skipped: [], error: '无法确定 origin 默认分支' };

    cleanup(); // 上次运行的残留
    const add = git(repo, ['worktree', 'add', wt, '-b', branch, `origin/${base}`]);
    if (!add.ok) return { ok: false, applied: [], skipped: [], error: `临时 worktree 创建失败：${add.out.slice(0, 200)}` };

    const r = applyClaudeMdSuggestions(wt, items);
    if (!r.applied.length) {
      cleanup();
      return { ok: true, applied: [], skipped: r.skipped }; // 主干已全有，无事可做
    }
    git(wt, ['add', 'CLAUDE.md']);
    const commit = git(wt, ['commit', '-m', `chore(${ticket}): adopt CLAUDE.md learnings`]);
    if (!commit.ok) {
      cleanup();
      return { ok: false, applied: [], skipped: [], error: `提交失败：${commit.out.slice(0, 200)}` };
    }

    let push = git(wt, [
      'push',
      '-o', 'merge_request.create',
      '-o', `merge_request.target=${base}`,
      '-o', `merge_request.title=chore(${ticket}): CLAUDE.md learnings`,
      'origin', branch,
    ]);
    let pushedBranch: string | undefined;
    if (!push.ok && /push.?option/i.test(push.out)) {
      push = git(wt, ['push', 'origin', branch]); // 远端不支持 push options：分支照推，MR 手动建
      if (push.ok) pushedBranch = branch;
    }
    if (!push.ok) {
      cleanup();
      return { ok: false, applied: r.applied, skipped: r.skipped, error: `推送失败：${push.out.slice(0, 200)}` };
    }
    const mrUrl = /https?:\/\/\S+\/merge_requests\/\d+/.exec(push.out)?.[0];
    cleanup();
    return { ok: true, applied: r.applied, skipped: r.skipped, mrUrl, pushedBranch };
  } catch (e) {
    cleanup();
    return { ok: false, applied: [], skipped: [], error: (e as Error).message.slice(0, 200) };
  }
}
