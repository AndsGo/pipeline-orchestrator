import { describe, expect, it } from 'vitest';
import { parseProfile } from '../profile.js';
import type { Action, Stage, StageResult } from '../types.js';
import {
  anchor,
  audienceOf,
  endLine,
  errorLine,
  nextActionLine,
  progressLine,
  startLine,
  triageLine,
} from '../voice.js';

const res = (over: Partial<StageResult>): StageResult => ({
  stage: 'review',
  status: 'DONE',
  handoff_path: 'docs/pipeline/T/30-review-r1.md',
  summary_for_card: 's',
  ...over,
});
const run = (stage: Stage): Action => ({ kind: 'run', stage });

describe('voice：业务受众口吻（只改编排器模板）', () => {
  it('audience 开关：PIPELINE.md 写 business/业务 才开，缺省与乱写都是 it（现状不变）', () => {
    expect(audienceOf(null)).toBe('it');
    expect(parseProfile('---\naudience: business\n---\n').audience).toBe('business');
    expect(parseProfile('---\naudience: 业务   # 群里是运营\n---\n').audience).toBe('business');
    expect(parseProfile('---\naudience: whatever\n---\n').audience).toBe('it');
    expect(parseProfile('---\ntestEnv: none\n---\n').audience).toBe('it');
  });

  it('状态锚：五步序列带序号；沉淀/CI 不算步', () => {
    expect(anchor('clarify')).toBe('整理需求 1/5');
    expect(anchor('acceptance')).toBe('验收 5/5');
    expect(anchor('compound')).toBe('总结归档');
  });

  it('开工行：动词按参数区分修复轮/带反馈重跑；有历史耗时才说区间；结尾「不用操作」', () => {
    expect(startLine('review', '', 8)).toBe('代码评审 4/5 · 开始代码评审，通常 6～12 分钟，不用操作');
    expect(startLine('implement', 'fix=docs/pipeline/T/30-review-r1.md', null)).toBe('开发 3/5 · 开始修改评审指出的问题，不用操作');
    expect(startLine('clarify', 'feedback=docs/pipeline/T/feedback.md', 0.5)).toBe('整理需求 1/5 · 按你的补充重新整理需求，通常 1～2 分钟，不用操作');
  });

  it('收尾行：评审 BLOCK 说清几条没过、几个要改，结尾指明自动发回；不出现状态码/sha/路径', () => {
    const r = res({
      verdict: 'BLOCK',
      axes: { spec: { total: 14, failed: 1, worst: 'AC-7' }, quality: { critical: 0, important: 1, minor: 0, worst: 'x' } },
    });
    const line = endLine(r, 2.98, { kind: 'fix', findingsPath: 'p', reverify: 'review' });
    expect(line).toBe('代码评审 4/5 · 评审：14 条验收标准有 1 条未满足、1 个问题需修改，发回修改（$2.98）\n自动发回开发修改，不用操作');
    expect(line).not.toMatch(/DONE|BLOCK|\.md|C0\/I1/);
  });

  it('收尾行：评审 PASS 附建议数；验收带待补验；NEEDS_CONTEXT 说几个问题 + 看卡片', () => {
    const pass = res({
      verdict: 'PASS',
      axes: { spec: { total: 14, failed: 0, worst: null }, quality: { critical: 0, important: 0, minor: 2, worst: null } },
    });
    expect(endLine(pass, 2.88, run('acceptance'))).toBe('代码评审 4/5 · 评审通过：14 条验收标准全部满足，附 2 条建议（$2.88）\n自动进入下一步：验收，不用操作');
    const acc = res({ stage: 'acceptance', status: 'DONE_WITH_CONCERNS', verdict: 'PASS' });
    const gate: Action = { kind: 'gate', gate: 'release-approval', summary: '', concerns: [], then: 'compound' };
    expect(endLine(acc, 0.8, gate)).toBe('验收 5/5 · 验收通过（有待补验项，见结果表）（$0.80）\n接下来需要你批准上线——看下面的卡片');
    const need = res({ stage: 'clarify', status: 'NEEDS_CONTEXT', open_questions: [{ id: 'Q1', question: 'q', options: ['a', 'b'], recommended: 'a', why: 'w' }] });
    const ask: Action = { kind: 'ask', questions: need.open_questions!, backfillTarget: 'x', backfillHeader: 'h', thenRerun: 'clarify' };
    expect(endLine(need, 2.74, ask)).toBe('整理需求 1/5 · 整理需求中有 1 个问题需要你确认（$2.74）\n有 1 个问题需要你回答——看下面的卡片');
    expect(nextActionLine({ kind: 'done' })).toBe('');
  });

  it('进度行：只翻「第 N 项完成 / 第 N 轮修改」，研发术语行不发', () => {
    expect(progressLine('Task 3: complete')).toBe('开发进度：第 3 项完成');
    expect(progressLine('## Review fix round 1: r1 Important-1')).toBe('开始第 1 轮修改');
    expect(progressLine('- 实现子代理模型：sonnet；scoped 复审 APPROVED_WITH_FINDINGS，仅 1 条 Minor，已 parked')).toBeNull();
  });

  it('分诊与出错：不露 Codex/API/阶段英文名，出错行带下一步', () => {
    expect(triageLine('full', '业务歧义：需澄清', 0.12)).toBe('已受理：走完整流程（整理需求 → 制定方案 → 开发 → 评审 → 验收）——业务歧义：需澄清（$0.12）');
    expect(errorLine('review', '会话异常：Codex 执行失败：out of credits', 'LS-9', 5)).toBe(
      '代码评审 4/5 · 这一步出错了，5 分钟后自动重试，不用操作。原因：Codex 执行失败：out of credits',
    );
    expect(errorLine('review', '会话异常：x', 'LS-9', null)).toContain('在群里说「继续 LS-9」可重试');
  });
});
