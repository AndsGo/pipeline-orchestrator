import { describe, expect, it, afterEach } from 'vitest';
import { buildFastlanePrompt, buildTriagePrompt, FASTLANE_SCHEMA, TRIAGE_SCHEMA } from '../lanes.js';
import { mergeReviewResults } from '../machine.js';
import { clearPaused, isPaused, setPaused } from '../pause.js';
import type { StageResult } from '../types.js';

function rev(verdict: StageResult['verdict'], over: Partial<StageResult> = {}): StageResult {
  return {
    stage: 'review',
    status: 'DONE',
    handoff_path: `docs/pipeline/T/30-review-${verdict}.md`,
    summary_for_card: `s-${verdict}`,
    verdict,
    ...over,
  };
}

describe('P2 双评审取严', () => {
  it('分歧时取更严结论，handoff 指向严方，分歧记入 concerns', () => {
    const m = mergeReviewResults(rev('PASS_WITH_SUGGESTIONS'), rev('BLOCK'));
    expect(m.verdict).toBe('BLOCK');
    expect(m.handoff_path).toContain('BLOCK');
    expect(m.status).toBe('DONE_WITH_CONCERNS');
    expect(m.concerns!.some((c) => c.includes('分歧'))).toBe(true);
    expect(m.summary_for_card).toContain('双评审取严');
  });

  it('结论一致时不注入分歧 concern，合并去重双方 concerns', () => {
    const m = mergeReviewResults(rev('PASS', { concerns: ['a'] }), rev('PASS', { concerns: ['a', 'b'], status: 'DONE_WITH_CONCERNS' }));
    expect(m.verdict).toBe('PASS');
    expect(m.concerns).toEqual(['a', 'b']);
    expect(m.summary_for_card).toBe('s-PASS');
  });

  it('严序：BLOCK > PASS_WITH_SUGGESTIONS > PASS（参数顺序无关）', () => {
    expect(mergeReviewResults(rev('BLOCK'), rev('PASS')).verdict).toBe('BLOCK');
    expect(mergeReviewResults(rev('PASS'), rev('PASS_WITH_SUGGESTIONS')).verdict).toBe('PASS_WITH_SUGGESTIONS');
  });
});

describe('P0 分诊与快车道契约', () => {
  it('schema 顶层无 allOf（API 限制）且必填字段齐全', () => {
    for (const s of [TRIAGE_SCHEMA, FASTLANE_SCHEMA] as Array<Record<string, unknown>>) {
      expect(s.allOf).toBeUndefined();
      expect(s.required).toBeDefined();
    }
  });

  it('分诊提示词包含保守原则；快车道提示词包含升级出口与分支纪律', () => {
    expect(buildTriagePrompt('需求 x')).toContain('拿不准一律 full');
    const fp = buildFastlanePrompt('T-9');
    expect(fp).toContain('feat/T-9-fast');
    expect(fp).toContain('ESCALATE');
    expect(fp).toContain('禁止在 main/master');
  });
});

describe('P1 暂停信号', () => {
  const T = 'PAUSE-TEST';
  afterEach(() => clearPaused(T));

  it('set → isPaused true → clear → false', () => {
    expect(isPaused(T)).toBe(false);
    setPaused(T, 'test');
    expect(isPaused(T)).toBe(true);
    clearPaused(T);
    expect(isPaused(T)).toBe(false);
  });
});
