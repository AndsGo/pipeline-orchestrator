import { execSync } from 'node:child_process';
import type { Project } from './projects.js';

/**
 * 接入新项目的纯逻辑层（《最后一公里》阶段 1，触发器：接第 2 个项目，2026-08-26）。
 * 脚本 scripts/add-project.ts 负责交互与落盘，这里只做可单测的部分：
 * 候选校验、.env 文本的精确编辑（只动目标行，其余字节原样保留——.env 里全是真凭据）。
 */

export interface NewProject {
  alias: string;
  repo: string;
  prefix: string;
  gitlab?: string;
  jenkins?: string;
  wikiArchive?: string;
}

/**
 * 该仓库是否把流水线工件目录挡在 git 外（实测 odoo-product 的 .gitignore 整行 `docs`，2026-09-02）。
 * 不是错误、是提醒：工件仍在盘上可用，但 MR 里看不到 PRD/评审、换 worktree 即丢。非 git 仓库返回 false
 */
export function pipelineDocsIgnored(repo: string): boolean {
  return gitIgnored(repo, 'docs/pipeline/x.md');
}

/**
 * CLAUDE.md 被 .gitignore 屏蔽（odoo-product 实测第 25 行，2026-09-03）：compound 采纳的沉淀建议
 * 走 MR 路径时 `git add` 静默失败、回退路径同样失败，常识只停在本机工作区，永远进不了主干、也到不了别的机器
 */
export function claudeMdIgnored(repo: string): boolean {
  return gitIgnored(repo, 'CLAUDE.md');
}

function gitIgnored(repo: string, relPath: string): boolean {
  try {
    execSync(`git check-ignore -q ${relPath}`, { cwd: repo, stdio: 'ignore' });
    return true; // 退出码 0 = 被忽略
  } catch {
    return false;
  }
}

/** 候选校验：返回错误清单（空数组 = 通过）。路径存在性等文件系统检查由调用方做 */
export function validateNewProject(existing: Project[], c: NewProject): string[] {
  const errs: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/i.test(c.alias)) errs.push(`别名「${c.alias}」不合法（字母开头，只含字母数字-）`);
  if (existing.some((p) => p.alias.toLowerCase() === c.alias.toLowerCase())) errs.push(`别名「${c.alias}」已存在`);
  if (!/^[A-Za-z]{1,6}$/.test(c.prefix)) errs.push(`前缀「${c.prefix}」不合法（1-6 个字母；工单号形如 ${c.prefix || 'XX'}-001）`);
  // 前缀是自然语言路由认工单归属的唯一依据，冲突会把 A 项目的工单派进 B 项目的仓库
  const clash = existing.find((p) => p.prefix.toLowerCase() === c.prefix.toLowerCase());
  if (clash) errs.push(`前缀「${c.prefix}」与项目 ${clash.alias} 冲突`);
  if (!c.repo.trim()) errs.push('仓库路径不能为空');
  return errs;
}

/** 读 .env 文本里某个变量的值（不看注释行）；不存在返回 null */
export function readEnvVar(envText: string, key: string): string | null {
  for (const line of envText.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * 更新/追加 .env 里的一个变量：只改目标行，其余内容与换行风格原样保留。
 * 不用 dotenv 库写回——那会重排整个文件，diff 里全是无关行，凭据文件经不起这种折腾。
 */
export function upsertEnvVar(envText: string, key: string, value: string): string {
  const eol = envText.includes('\r\n') ? '\r\n' : '\n';
  const lines = envText.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => !l.trimStart().startsWith('#') && re.test(l));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  return lines.join(eol);
}

/**
 * 人会直接粘 clone URL（http://…/组/项目.git）——剥成内部要的「组/项目」。
 * 实测（nova 接入，2026-08-26）：填了完整 URL，工件链接会拼成 http://host/http://host/… 的坏链接。
 */
export function normalizeGitlabPath(v: string): string {
  return v
    .trim()
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
}

/** 同上：wiki 归档节点人会粘页面 URL（https://…/wiki/<token>）——剥出 token */
export function normalizeWikiToken(v: string): string {
  const m = /\/wiki\/([A-Za-z0-9]+)/.exec(v);
  return (m ? m[1] : v).trim();
}

/** 把新项目并入 PIPELINE_PROJECTS 的 JSON 值（单行序列化，.env 一行一变量）。宽容输入在此收口 */
export function projectsJsonWith(currentJson: string, c: NewProject): string {
  const raw = JSON.parse(currentJson) as Record<string, unknown>;
  raw[c.alias] = {
    repo: c.repo.replace(/\\/g, '/'),
    prefix: c.prefix.toUpperCase(),
    ...(c.gitlab ? { gitlab: normalizeGitlabPath(c.gitlab) } : {}),
    ...(c.jenkins ? { jenkins: c.jenkins } : {}),
    ...(c.wikiArchive ? { wikiArchive: normalizeWikiToken(c.wikiArchive) } : {}),
  };
  return JSON.stringify(raw);
}
