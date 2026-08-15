import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';

/**
 * 从工件里提取“审批人做决策真正需要看的东西”，直接拼进卡片。
 * 刻意不生成任何新文档：git 是全文的权威源，卡片只承载决策材料。
 */

const MAX_DETAIL = 3000; // 卡片能装 30KB，但太长就没人读了

function clip(s: string, n = MAX_DETAIL): string {
  return s.length > n ? s.slice(0, n) + '\n…（全文见工件）' : s;
}

function read(repo: string, ticket: string, file: string): string | null {
  const p = path.join(ticketDir(repo, ticket), file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

/** 取某个 `## 标题` 小节的正文 */
export function section(md: string, heading: string): string {
  const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  return re.exec(md)?.[1]?.trim() ?? '';
}

/** AC 清单：编号 + 标题 + 自动/人工。审批 PRD 时真正要看的就是这个 */
export function acDigest(prd: string): string {
  const lines: string[] = [];
  const re = /^###\s*(AC-\d+)[:：]\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prd))) {
    const rest = prd.slice(m.index, m.index + 900);
    const how = /\*\*验证方式：?\*\*\s*(自动|人工)/.exec(rest)?.[1] ?? '?';
    // 去掉"（验证 R-1）""（回归，验证 R-1）"这类溯源后缀——卡片上是决策材料，不是溯源表
    const title = m[2].replace(/[（(][^）)]*验证\s*R-\d+[^）)]*[）)]/g, '').trim();
    lines.push(`${how === '自动' ? '🤖' : '🙋'} **${m[1]}** ${title}`);
  }
  return lines.length ? lines.join('\n') : '';
}

/**
 * 把长条目压成一行要点：真实 PRD 的范围条目常是带文件路径的整段，
 * 原样搬进卡片会把最该看的 AC 清单挤没。
 */
export function condenseBullets(text: string, maxItems = 5, maxChars = 64): string {
  const items = text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
  const shown = items.slice(0, maxItems).map((s) => {
    const first = s.split(/[。；;]/)[0].replace(/`/g, '').trim();
    return `- ${first.length > maxChars ? first.slice(0, maxChars) + '…' : first}`;
  });
  if (items.length > maxItems) shown.push(`- …另 ${items.length - maxItems} 条`);
  return shown.join('\n');
}

/** In / Out 范围：审批时最该确认的边界（压成要点，不搬原文） */
export function scopeDigest(prd: string): string {
  const scope = section(prd, '范围');
  if (!scope) return '';
  const pick = (label: string): string => {
    const re = new RegExp(`\\*\\*${label}：?\\*\\*([\\s\\S]*?)(?=\\*\\*(?:In|Out)：?\\*\\*|$)`);
    return (re.exec(scope)?.[1] ?? '').trim();
  };
  const inn = pick('In');
  const out = pick('Out');
  return [inn && `**做**\n${condenseBullets(inn)}`, out && `**不做**\n${condenseBullets(out)}`]
    .filter(Boolean)
    .join('\n\n');
}

/** 任务清单标题（含覆盖的 AC），让审批人看到计划被拆成了什么 */
export function taskDigest(plan: string): string {
  const lines = [...plan.matchAll(/^###\s*(Task \d+)[:：]\s*(.+?)\s*$/gm)].map((m) => `- **${m[1]}** ${m[2]}`);
  return lines.join('\n');
}

/** 组装某个卡点的决策材料；无可提取内容时返回空串（卡片退回纯摘要） */
export function gateDetail(gate: string, repo: string, ticket: string): string {
  try {
    if (gate === 'prd-confirm') {
      const prd = read(repo, ticket, '10-prd.md');
      if (!prd) return '';
      const ac = acDigest(prd);
      const scope = scopeDigest(prd);
      // AC 清单在前且完整——审批 PRD 决策的就是它；范围压成要点垫后
      const parts = [
        ac && `**验收标准（${ac.split('\n').length} 条 · 🤖自动 / 🙋人工）**\n${ac}`,
        scope && `**范围**\n${scope}`,
      ].filter(Boolean);
      return clip(parts.join('\n\n'));
    }
    if (gate === 'plan-approval') {
      const plan = read(repo, ticket, '20-plan.md');
      if (!plan) return '';
      const summary = section(plan, '审批摘要');
      const tasks = taskDigest(plan);
      const parts = [summary, tasks && `**任务拆分（${tasks.split('\n').length} 个）**\n${tasks}`].filter(Boolean);
      return clip(parts.join('\n\n'));
    }
    if (gate === 'deploy-approval') {
      const rev = fs
        .readdirSync(ticketDir(repo, ticket))
        .filter((f) => /^30-review-r\d+\.md$/.test(f))
        .sort()
        .pop();
      const md = rev ? read(repo, ticket, rev) : null;
      return md ? clip(section(md, '本阶段结论'), 1500) : '';
    }
  } catch {
    /* 提取失败不能挡住审批 */
  }
  return '';
}
