import fs from 'node:fs';
import path from 'node:path';
import { activeOnly, type KnowledgeEntry } from './knowledge.js';
import { dataDir } from './paths.js';

/**
 * 知识库老化审计的制度化（《押注三项资产》单元三收尾项，2026-08-26）。
 * 业界教训：模型识别「记忆已过时」准确率仅 ~55%，过时下线要靠定期审计而不是运行时指望模型；
 * 而审计脚本（scripts/kb-refresh-audit.ts）在仓库里躺了一周没人跑——制度化 = daemon 到期自动跑
 * 零成本老化报告并发到群里。深检（模型对照代码库）仍走脚本手动跑，那是要花钱的决定。
 * 审计只提建议不动数据：下线（状态→已失效）由人在知识表操作。
 */

const stampFile = (): string => path.join(dataDir(), 'kb-audit-last.json');

export const AUDIT_INTERVAL_DAYS = 30;
export const STALE_DAYS = 30;

/** 是否到期：从未跑过（含戳文件损坏）视为到期 */
export function dueForAudit(lastAt: string | null, now: number, intervalDays = AUDIT_INTERVAL_DAYS): boolean {
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return true;
  return now - t >= intervalDays * 86400000;
}

export function readAuditStamp(file = stampFile()): string | null {
  try {
    const at = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { at?: string }).at;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

/** 写失败不抛：戳丢了顶多下次重发一份报告，不能反过来影响 daemon */
export function writeAuditStamp(at = new Date().toISOString(), file = stampFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at }), 'utf-8');
  } catch {
    /* 见上 */
  }
}

/** 老化候选：生效条目中超过 staleDays 未命中或从未命中的（待审/已失效不参与注入，不算老化） */
export function staleActive(
  entries: KnowledgeEntry[],
  hits: Map<string, string>,
  now: number,
  staleDays = STALE_DAYS,
): KnowledgeEntry[] {
  return activeOnly(entries).filter((e) => {
    const ts = hits.get(e.title);
    if (!ts) return true;
    return now - Date.parse(ts) > staleDays * 86400000;
  });
}

/** 群消息文案：总量 + 老化候选清单（最多 10 条）+ 处置指引 */
export function agingSummary(entries: KnowledgeEntry[], hits: Map<string, string>, now: number): string {
  const active = activeOnly(entries);
  const stale = staleActive(entries, hits, now);
  const head = `📋 知识库月度老化审计（自动）：共 ${entries.length} 条，生效 ${active.length} 条。`;
  if (!stale.length) return `${head}\n全部生效条目 ${STALE_DAYS} 天内都有命中，无老化候选。`;
  const line = (e: KnowledgeEntry): string => {
    const ts = hits.get(e.title);
    const ago = ts ? `${Math.floor((now - Date.parse(ts)) / 86400000)} 天前命中` : '从未命中';
    return `- ${e.title.slice(0, 60)}（${ago}${e.ticket ? `，来源 ${e.ticket}` : ''}）`;
  };
  return [
    head,
    `超过 ${STALE_DAYS} 天未命中的生效条目 **${stale.length} 条**：`,
    ...stale.slice(0, 10).map(line),
    ...(stale.length > 10 ? [`…及另外 ${stale.length - 10} 条（完整表见多维表格知识表）`] : []),
    '',
    '处置：确认已过时的，在知识表把「状态」改为「已失效」（保留历史，不删）；',
    '拿不准的可跑深检（模型对照代码库，约 $1-2）：npx tsx scripts/kb-refresh-audit.ts --deep <仓库路径>',
  ].join('\n');
}
