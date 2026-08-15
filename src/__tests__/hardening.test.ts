import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { formatComment, parseNoteEvent, resolveRepo, shouldTrigger, type MrReviewResult } from '../gitlab/core.js';
import { acquireLock, releaseLock } from '../lock.js';
import { validateResult } from '../schema.js';

const T = 'LOCK-TEST';
afterEach(() => releaseLock(T));

describe('工单级 PID 锁', () => {
  it('获取 → 同工单再获取被拒 → 释放后可再获取', () => {
    expect(acquireLock(T).ok).toBe(true);
    // 模拟另一个进程：持有者 pid 改写为一个"存活"的其他 pid
    const f = new URL('../../data/LOCK-TEST.lock', import.meta.url);
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid + 999999, startedAt: 'x' }));
    const denied = acquireLock(T, () => true); // pidAlive 恒真 → 拒绝
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.holder.pid).toBe(process.pid + 999999);
  });

  it('陈旧锁（持有者已死）自动接管', () => {
    const f = new URL('../../data/LOCK-TEST.lock', import.meta.url);
    fs.mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: 1, startedAt: 'x' }));
    expect(acquireLock(T, () => false).ok).toBe(true); // pidAlive 恒假 → 接管
  });

  it('锁文件损坏视为陈旧', () => {
    const f = new URL('../../data/LOCK-TEST.lock', import.meta.url);
    fs.mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
    fs.writeFileSync(f, 'not-json');
    expect(acquireLock(T, () => true).ok).toBe(true);
  });
});

describe('契约 0.4.0：open_questions.options 必填', () => {
  const base = { stage: 'clarify', status: 'NEEDS_CONTEXT', handoff_path: 'docs/pipeline/T/10-prd.md', summary_for_card: 's' };
  it('缺 options 的问题被回程校验拒绝（真机缺陷回归）', () => {
    const bad = { ...base, open_questions: [{ id: 'Q1', question: 'q', recommended: 'r', why: 'w' }] };
    expect(validateResult(bad).length).toBeGreaterThan(0);
    const good = { ...base, open_questions: [{ id: 'Q1', question: 'q', options: ['A', 'B'], recommended: 'A', why: 'w' }] };
    expect(validateResult(good)).toEqual([]);
  });
});

describe('GitLab note 事件解析与触发', () => {
  const event = {
    object_kind: 'note',
    project: { path_with_namespace: 'lego/lake_spirit' },
    object_attributes: { note: '请 @ai-review 看下这个 MR', noteable_type: 'MergeRequest' },
    merge_request: { iid: 12, source_branch: 'feat/x', target_branch: 'main' },
    user: { username: 'songxulin' },
  };

  it('MR 评论事件解析出全部字段', () => {
    expect(parseNoteEvent(event)).toEqual({
      projectPath: 'lego/lake_spirit',
      mrIid: 12,
      comment: '请 @ai-review 看下这个 MR',
      author: 'songxulin',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
    });
  });

  it('非 MR 评论（issue note / push）返回 null', () => {
    expect(parseNoteEvent({ ...event, object_attributes: { note: 'x', noteable_type: 'Issue' } })).toBeNull();
    expect(parseNoteEvent({ object_kind: 'push' })).toBeNull();
  });

  it('触发词判定：命中触发词或 @bot 用户名', () => {
    expect(shouldTrigger('请 @ai-review 看看', '@ai-review')).toBe(true);
    expect(shouldTrigger('LGTM', '@ai-review')).toBe(false);
    expect(shouldTrigger('@review-bot 看看', '@ai-review', 'review-bot')).toBe(true);
  });

  it('bot 自己的回帖（含签名）绝不触发——防自触发死循环（真机事故回归）', () => {
    const r: MrReviewResult = { verdict: 'PASS', summary: 'ok', findings: [] };
    const botComment = formatComment(r, '@ai-review');
    expect(shouldTrigger(botComment, '@ai-review')).toBe(false);
    // 且页脚不得包含触发词原文
    expect(botComment.includes('@ai-review')).toBe(false);
  });

  it('仓库映射：未登记项目返回 null', () => {
    const map = { 'lego/lake_spirit': 'D:/work/lake_spirit' };
    expect(resolveRepo(map, 'lego/lake_spirit')).toBe('D:/work/lake_spirit');
    expect(resolveRepo(map, 'other/proj')).toBeNull();
  });
});

describe('MR 回帖格式', () => {
  it('BLOCK 带 findings 表格且转义竖线', () => {
    const r: MrReviewResult = {
      verdict: 'BLOCK',
      summary: '有一处越权',
      findings: [{ severity: 'Critical', file: 'a.go', line: 10, issue: '越权|绕过', scenario: '未授权用户可调用' }],
    };
    const c = formatComment(r, '@ai-review');
    expect(c).toContain('⛔');
    expect(c).toContain('`a.go:10`');
    expect(c).toContain('越权\\|绕过');
  });

  it('PASS 无 findings 不渲染表格', () => {
    const c = formatComment({ verdict: 'PASS', summary: 'ok', findings: [] }, '@ai-review');
    expect(c).toContain('✅');
    expect(c).not.toContain('| 级别 |');
  });
});
