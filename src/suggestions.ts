import fs from 'node:fs';
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
