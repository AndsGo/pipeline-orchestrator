import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastHitByTitle, recordHits } from '../hits.js';
import { computeMetrics, metricsDashItems } from '../metrics.js';

const run = (stage: string, verdict?: string) => ({ stage, status: 'DONE', verdict }) as never;
const st = (runs: unknown[], rf = 0, af = 0) =>
  ({ runs, reviewFixRounds: rf, acceptanceFixRounds: af }) as never;

describe('computeMetrics（质量三指标）', () => {
  it('一次通过 = 首轮 review 非 BLOCK；返工 = acceptanceFixRounds>0', () => {
    const m = computeMetrics([
      st([run('review', 'PASS'), run('acceptance', 'PASS')]), // 一次通过，无返工
      st([run('review', 'BLOCK'), run('review', 'PASS_WITH_SUGGESTIONS'), run('acceptance', 'PASS')], 1, 1), // 打回过+验收返工
      st([run('clarify')]), // 未到 review，不进样本
    ]);
    expect(m.reviewSamples).toBe(2);
    expect(m.firstPassReview).toBe(1);
    expect(m.totalReviewFixRounds).toBe(1);
    expect(m.acceptanceSamples).toBe(2);
    expect(m.acceptanceReworked).toBe(1);
  });

  it('渲染：无样本时不渲染，避免面板出现一排 0/0', () => {
    expect(metricsDashItems(computeMetrics([]))).toEqual([]);
    const items = metricsDashItems(computeMetrics([st([run('review', 'PASS')])]));
    expect(items.find((i) => i.label === '评审一次通过')?.value).toContain('1/1（100%）');
  });
});

describe('hits（命中日志）', () => {
  it('记录与最近命中回读；空命中不写；坏行跳过', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hits-')), 'h.jsonl');
    recordHits('run', 'knowledge', [], f);
    expect(fs.existsSync(f)).toBe(false);
    recordHits('ticket:LS-1', 'knowledge', ['甲', '乙'], f);
    recordHits('run', 'term', ['术语A'], f);
    fs.appendFileSync(f, '坏行{{{\n', 'utf-8');
    recordHits('run', 'knowledge', ['甲'], f);
    const k = lastHitByTitle('knowledge', f);
    expect(k.has('甲')).toBe(true);
    expect(k.has('乙')).toBe(true);
    expect(k.has('术语A')).toBe(false); // kind 隔离
    expect(lastHitByTitle('term', f).has('术语A')).toBe(true);
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
});
