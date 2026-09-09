import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';

/**
 * 知识条目：compound 阶段产出 96-knowledge.json，编排器投影进多维表格；
 * 反向地，开工前把相关条目预取成 05-knowledge-hints.md 交给 clarify/plan 读——
 * 知识库有一个每天读它的消费者（agent），才不会腐烂。
 */

export interface KnowledgeEntry {
  title: string;
  kind: '踩坑' | '项目常识' | '流程改进' | '决策先例' | string;
  /** 适用范围：本项目 / 技术栈 / 执行环境 / 流程。决定这条经验会不会喂给别的项目 */
  scope?: '本项目' | '技术栈' | '执行环境' | '流程' | string;
  /** 状态门：待审 / 生效 / 待复核 / 已失效。只有「生效」参与注入；状态门之前的存量条目无该字段，视同生效 */
  status?: '待审' | '生效' | '待复核' | '已失效' | string;
  tags: string[];
  symptom: string;
  cause: string;
  practice: string;
  ticket?: string;
  project?: string;
  evidence?: string;
}

/** 注入过滤：只放行「生效」条目；无状态的存量条目视同生效（状态门上线前的 9 条不重新过审） */
export function activeOnly(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.filter((e) => !e.status || e.status === '生效');
}

export const KNOWLEDGE_FILE = '96-knowledge.json';
export const HINTS_FILE = '05-knowledge-hints.md';
export const DELIVERY_FILE = '95-delivery.md';

/** 读取 compound 产出的知识条目；格式不合法时返回空数组并说明（宁可不投影也不投脏数据） */
export function readKnowledgeFile(repo: string, ticket: string): { entries: KnowledgeEntry[]; error?: string } {
  const f = path.join(ticketDir(repo, ticket), KNOWLEDGE_FILE);
  if (!fs.existsSync(f)) return { entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as unknown;
    const arr = Array.isArray(raw) ? raw : (raw as { entries?: unknown[] }).entries;
    if (!Array.isArray(arr)) return { entries: [], error: '不是数组' };
    return { entries: arr.filter(isEntry).map((e) => ({ ...e, ticket: e.ticket ?? ticket })) };
  } catch (e) {
    return { entries: [], error: (e as Error).message };
  }
}

function isEntry(v: unknown): v is KnowledgeEntry {
  const e = v as KnowledgeEntry;
  return !!e && typeof e.title === 'string' && e.title.length > 0 && typeof e.practice === 'string';
}

/** 关键词打分：标题/标签/现象命中需求文本的词，得分高者优先 */
export function scoreEntry(entry: KnowledgeEntry, needleWords: string[]): number {
  const hay = `${entry.title} ${entry.tags.join(' ')} ${entry.symptom}`.toLowerCase();
  let s = 0;
  for (const w of needleWords) if (w.length >= 2 && hay.includes(w)) s += w.length >= 4 ? 3 : 1;
  return s;
}

/** 从需求原文切出候选词（中英混排：英文按词，中文按 2-3 字滑窗） */
export function keywords(text: string): string[] {
  const en = (text.toLowerCase().match(/[a-z][a-z0-9_/-]{2,}/g) ?? []).slice(0, 40);
  const zh = new Set<string>();
  const clean = text.replace(/[^一-龥]/g, ' ');
  for (const seg of clean.split(/\s+/)) {
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= seg.length; i++) zh.add(seg.slice(i, i + n));
  }
  return [...new Set([...en, ...[...zh].slice(0, 80)])];
}

/**
 * 按项目过滤：本项目的全部保留；非本项目的条目只有标为"技术栈/执行环境/流程"才跨项目复用。
 * 硬隔离会白丢掉"GORM default tag 的坑"这类通用经验，全放行又会串味，所以按适用范围软隔离。
 */
export function filterByProject(all: KnowledgeEntry[], project?: string): KnowledgeEntry[] {
  if (!project) return all;
  return all.filter((e) => {
    if (!e.project || e.project === project) return true;
    return !!e.scope && e.scope !== '本项目';
  });
}

/** 选出要提示的条目：先按项目过滤，再按相关性取前 limit 条 */
export function selectHints(all: KnowledgeEntry[], requirement: string, limit = 12, project?: string): KnowledgeEntry[] {
  const pool = filterByProject(all, project);
  if (pool.length <= limit) return pool;
  const words = keywords(requirement);
  return [...pool]
    .map((e) => ({ e, s: scoreEntry(e, words) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

export function renderHints(entries: KnowledgeEntry[]): string {
  if (!entries.length) return '';
  const body = entries
    .map(
      (e) =>
        `### ${e.title}\n- **类型**：${e.kind}${e.scope ? `　**适用**：${e.scope}` : ''}${e.tags.length ? `　**标签**：${e.tags.join('、')}` : ''}\n- **现象**：${e.symptom}\n- **根因**：${e.cause}\n- **正确做法**：${e.practice}\n- **来源**：${e.ticket ?? '—'}${e.project && e.project !== '本项目' ? `（项目 ${e.project}）` : ''}${e.evidence ? `（${e.evidence}）` : ''}`,
    )
    .join('\n\n');
  return [
    '# 历史知识提示',
    '',
    '> 本文件由编排器从知识库自动预取，**是过往工单的经验，不是本单的需求**。',
    '> 与本单相关的条目请在方案/计划里显式采纳或显式排除并说明理由；无关的忽略即可。',
    '',
    body,
    '',
  ].join('\n');
}

/** 写入提示文件；无条目时删除旧文件，避免上一轮的提示误导本轮 */
export function writeHints(repo: string, ticket: string, entries: KnowledgeEntry[]): boolean {
  const f = path.join(ticketDir(repo, ticket), HINTS_FILE);
  if (!entries.length) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 无所谓 */
    }
    return false;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, renderHints(entries), 'utf-8');
  return true;
}
