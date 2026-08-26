import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agingSummary, dueForAudit, readAuditStamp, staleActive, writeAuditStamp } from '../kbAudit.js';
import type { KnowledgeEntry } from '../knowledge.js';

const DAY = 86400000;
const NOW = Date.parse('2026-08-26T00:00:00.000Z');

function entry(title: string, status?: string): KnowledgeEntry {
  return { title, kind: '踩坑', status, tags: [], symptom: 's', cause: 'c', practice: 'p' };
}
const hitAt = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

describe('dueForAudit（30 天到期）', () => {
  it('从未跑过 / 戳损坏 → 到期', () => {
    expect(dueForAudit(null, NOW)).toBe(true);
    expect(dueForAudit('not-a-date', NOW)).toBe(true);
  });
  it('29 天不到期，30 天到期', () => {
    expect(dueForAudit(hitAt(29), NOW)).toBe(false);
    expect(dueForAudit(hitAt(30), NOW)).toBe(true);
  });
});

describe('staleActive（老化候选）', () => {
  it('生效且超 30 天未命中/从未命中 → 候选；30 天内命中 → 不候选', () => {
    const hits = new Map([
      ['近', hitAt(5)],
      ['远', hitAt(45)],
    ]);
    const out = staleActive([entry('近'), entry('远'), entry('无')], hits, NOW).map((e) => e.title);
    expect(out).toEqual(['远', '无']);
  });
  it('待审/已失效不参与注入，也不算老化', () => {
    const out = staleActive([entry('a', '待审'), entry('b', '已失效'), entry('c', '生效')], new Map(), NOW);
    expect(out.map((e) => e.title)).toEqual(['c']);
  });
  it('无状态的存量条目视同生效参与审计', () => {
    expect(staleActive([entry('旧')], new Map(), NOW)).toHaveLength(1);
  });
});

describe('agingSummary（群消息文案）', () => {
  it('有候选：报总数、候选数与明细，附处置指引', () => {
    const s = agingSummary([entry('近'), entry('远')], new Map([['近', hitAt(1)], ['远', hitAt(60)]]), NOW);
    expect(s).toContain('共 2 条，生效 2 条');
    expect(s).toContain('**1 条**');
    expect(s).toContain('远（60 天前命中');
    expect(s).toContain('已失效');
    expect(s).toContain('--deep');
  });
  it('无候选：一句话报平安，不给空清单', () => {
    const s = agingSummary([entry('近')], new Map([['近', hitAt(1)]]), NOW);
    expect(s).toContain('无老化候选');
    expect(s).not.toContain('- ');
  });
  it('候选超过 10 条只列前 10 并注明剩余', () => {
    const many = Array.from({ length: 13 }, (_, i) => entry(`条目${i}`));
    const s = agingSummary(many, new Map(), NOW);
    expect(s).toContain('另外 3 条');
  });
});

describe('审计时间戳落盘', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-audit-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('写后可读回；无文件/损坏返回 null', () => {
    const f = path.join(dir, 'stamp.json');
    expect(readAuditStamp(f)).toBeNull();
    writeAuditStamp('2026-08-26T00:00:00.000Z', f);
    expect(readAuditStamp(f)).toBe('2026-08-26T00:00:00.000Z');
    fs.writeFileSync(f, '{broken', 'utf-8');
    expect(readAuditStamp(f)).toBeNull();
  });
});
