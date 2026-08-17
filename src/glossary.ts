import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';

/**
 * 业务术语表：clarify 访谈是采集点（93-terms.json 提议 → 人审卡 → 术语表），
 * 编排器把项目子集预取成 06-glossary.md 给各阶段读，/run 按命中注入。
 * agent 会放大喂给它的词汇歧义——术语统一是业务知识资产的地基。
 */

export interface Term {
  term: string;
  definition: string;
  /** 业务上指同一概念但不允许使用的说法 */
  banned?: string[];
  /** 所属域（bounded context / 模块） */
  domain?: string;
  /** 待审 / 生效 / 已失效；存量无状态视同生效 */
  status?: string;
  project?: string;
  ticket?: string;
}

export const TERMS_FILE = '93-terms.json';
export const GLOSSARY_FILE = '06-glossary.md';

/** 读取 clarify 产出的新术语提议；缺失 = 无提议 */
export function readTermsFile(repo: string, ticket: string): { terms: Term[]; error?: string } {
  const f = path.join(ticketDir(repo, ticket), TERMS_FILE);
  if (!fs.existsSync(f)) return { terms: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as unknown;
    const arr = Array.isArray(raw) ? raw : (raw as { terms?: unknown[] }).terms;
    if (!Array.isArray(arr)) return { terms: [], error: '不是数组' };
    return { terms: arr.filter(isTerm).map((t) => ({ ...t, banned: t.banned ?? [], ticket: t.ticket ?? ticket })) };
  } catch (e) {
    return { terms: [], error: (e as Error).message };
  }
}

function isTerm(v: unknown): v is Term {
  const t = v as Term;
  return !!t && typeof t.term === 'string' && t.term.trim().length > 0 && typeof t.definition === 'string' && t.definition.trim().length > 0;
}

/** 注入过滤：只放行「生效」；存量无状态视同生效（与知识表同规则） */
export function activeTermsOnly(terms: Term[]): Term[] {
  return terms.filter((t) => !t.status || t.status === '生效');
}

/** 项目过滤：本项目的 + 未标项目的通用词条 */
export function filterTermsByProject(terms: Term[], project?: string): Term[] {
  if (!project) return terms;
  return terms.filter((t) => !t.project || t.project === project);
}

/** 命中：规范词或任一禁用同义词出现在文本里（术语是精确字符串，子串匹配即正确语义） */
export function matchTerms(text: string, terms: Term[]): Term[] {
  return terms.filter((t) => text.includes(t.term) || (t.banned ?? []).some((b) => b && text.includes(b)));
}

/** 完整术语表渲染（06-glossary.md） */
export function renderGlossary(terms: Term[]): string {
  if (!terms.length) return '';
  const body = terms
    .map(
      (t) =>
        `### ${t.term}${t.domain ? `（${t.domain}）` : ''}\n- **定义**：${t.definition}` +
        (t.banned?.length ? `\n- **用词纪律**：用「${t.term}」，不要用「${t.banned.join('」「')}」` : ''),
    )
    .join('\n\n');
  return [
    '# 项目术语表',
    '',
    '> 本文件由编排器从术语表自动预取。**PRD/计划/报告中的业务名词必须使用这里的规范词**，出现禁用同义词算产物缺陷。',
    '',
    body,
    '',
  ].join('\n');
}

/** /run 注入用的紧凑版：只带命中的词条 */
export function renderTermsBrief(terms: Term[]): string {
  if (!terms.length) return '';
  return [
    '（以下是本项目的业务术语定义，请按此理解与用词）',
    ...terms.map(
      (t) => `- 「${t.term}」：${t.definition}${t.banned?.length ? `（不要说「${t.banned.join('」「')}」）` : ''}`,
    ),
    '',
  ].join('\n');
}

/** 写入术语表文件；无词条时删除旧文件（与 hints 同规则） */
export function writeGlossaryFile(repo: string, ticket: string, terms: Term[]): boolean {
  const f = path.join(ticketDir(repo, ticket), GLOSSARY_FILE);
  if (!terms.length) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 无所谓 */
    }
    return false;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, renderGlossary(terms), 'utf-8');
  return true;
}
