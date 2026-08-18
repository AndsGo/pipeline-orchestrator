import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 知识/术语命中日志：每次注入记下具体条目。
 * 「注入 5 条」只能证明检索在跑；要回答「这条知识有没有用」「哪些条目从没被命中该下线」，
 * 必须知道命中的是谁——这是生命周期审计（kb-refresh-audit）的数据底座。
 */

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/knowledge-hits.jsonl');

export interface HitRecord {
  ts: string;
  /** 来源：ticket:LS-8:clarify / run / mr-review… */
  source: string;
  kind: 'knowledge' | 'term';
  titles: string[];
}

/** 追加命中记录（best-effort：记不上不影响主流程） */
export function recordHits(source: string, kind: HitRecord['kind'], titles: string[], file = DEFAULT_FILE): void {
  if (!titles.length) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec: HitRecord = { ts: new Date().toISOString(), source, kind, titles };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf-8');
  } catch {
    /* 命中日志是旁路 */
  }
}

/** 每个条目的最近命中时间（审计用） */
export function lastHitByTitle(kind: HitRecord['kind'], file = DEFAULT_FILE): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as HitRecord;
        if (r.kind !== kind) continue;
        for (const t of r.titles) out.set(t, r.ts); // 文件按时间追加，后写覆盖即最近
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 无文件 = 无记录 */
  }
  return out;
}
