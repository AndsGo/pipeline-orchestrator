import fs from 'node:fs';
import path from 'node:path';
import type { DashItem } from './dashboard.js';
import { dataDir } from './paths.js';
import type { TicketState } from './types.js';

/**
 * 质量三指标：一次通过率 / 评审修复轮数 / 验收返工率。
 * 「越用越准」必须可以被回答而不是被感觉——这三个数就是回答的载体，
 * 对照实验（PIPELINE_HINTS_OFF 控制期）也用它们比较。
 */

type MetricState = Pick<TicketState, 'runs' | 'reviewFixRounds' | 'acceptanceFixRounds'>;

export interface QualityMetrics {
  /** 有过 review 定稿的工单数（一次通过率的分母） */
  reviewSamples: number;
  /** 首轮 review 非 BLOCK 的工单数 */
  firstPassReview: number;
  totalReviewFixRounds: number;
  /** 跑过 acceptance 定稿的工单数 */
  acceptanceSamples: number;
  /** 验收发生过返工（acceptanceFixRounds>0）的工单数 */
  acceptanceReworked: number;
}

export function computeMetrics(states: MetricState[]): QualityMetrics {
  const m: QualityMetrics = {
    reviewSamples: 0,
    firstPassReview: 0,
    totalReviewFixRounds: 0,
    acceptanceSamples: 0,
    acceptanceReworked: 0,
  };
  for (const s of states) {
    const firstReview = s.runs.find((r) => r.stage === 'review' && r.verdict);
    if (firstReview) {
      m.reviewSamples++;
      if (firstReview.verdict !== 'BLOCK') m.firstPassReview++;
      m.totalReviewFixRounds += s.reviewFixRounds ?? 0;
    }
    if (s.runs.some((r) => r.stage === 'acceptance' && r.verdict)) {
      m.acceptanceSamples++;
      if ((s.acceptanceFixRounds ?? 0) > 0) m.acceptanceReworked++;
    }
  }
  return m;
}

/** 读全部工单快照（<前缀>-<号>.json；索引/pid 等其他 data 文件不算） */
export function readAllSnapshots(dir = dataDir()): MetricState[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^[A-Za-z]+-\d+\.json$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as TicketState;
        } catch {
          return null;
        }
      })
      .filter((s): s is TicketState => !!s && Array.isArray(s.runs));
  } catch {
    return [];
  }
}

export function metricsDashItems(m: QualityMetrics): DashItem[] {
  if (!m.reviewSamples && !m.acceptanceSamples) return [];
  const pct = (a: number, b: number): string => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : '—');
  return [
    { label: '评审一次通过', value: pct(m.firstPassReview, m.reviewSamples) },
    {
      label: '评审修复轮',
      value: m.reviewSamples ? `共 ${m.totalReviewFixRounds} 轮 · 平均 ${(m.totalReviewFixRounds / m.reviewSamples).toFixed(1)}` : '—',
    },
    { label: '验收返工', value: pct(m.acceptanceReworked, m.acceptanceSamples) },
  ];
}
