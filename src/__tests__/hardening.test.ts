import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { interruptedStage, lostPendingCards, type PipelineEvent } from '../events.js';
import { formatComment, parseNoteEvent, previewContentType, previewLocalPath, resolveRepo, shouldTrigger, type MrReviewResult } from '../gitlab/core.js';
import { previewUrl } from '../prototype.js';
import { acquireLock, releaseLock } from '../lock.js';
import { validateResult } from '../schema.js';

const T = 'LOCK-TEST';
afterEach(() => releaseLock(T));

const ev = (type: PipelineEvent['type'], stage?: string): PipelineEvent => ({
  ts: new Date().toISOString(),
  ticket: 'T',
  type,
  stage,
  summary: 's',
});

describe('中断巡检（LS-013 事故回归：重启杀掉进行中的 clarify，工单静停 13 小时没人知道）', () => {
  it('stage.start 后无终结事件 → 判中断并报出阶段', () => {
    expect(interruptedStage([ev('ticket.created'), ev('triage'), ev('stage.start', 'clarify')])).toBe('clarify');
  });

  it('等人工不算中断：stage.end 之后跟 gate.asked / question.asked', () => {
    expect(interruptedStage([ev('stage.start', 'review'), ev('stage.end', 'review'), ev('gate.asked', 'review')])).toBeNull();
    expect(interruptedStage([ev('stage.start', 'acceptance'), ev('stage.end', 'acceptance'), ev('question.asked', 'acceptance')])).toBeNull();
  });

  it('挂起（halt）、闭环（done）、runner 异常（error）都算已终结——它们各有自己的提示路径', () => {
    expect(interruptedStage([ev('stage.start', 'implement'), ev('halt', 'implement')])).toBeNull();
    expect(interruptedStage([ev('stage.start', 'compound'), ev('stage.end', 'compound'), ev('done')])).toBeNull();
    expect(interruptedStage([ev('stage.start', 'plan'), ev('error')])).toBeNull();
  });

  it('implement 的进度事件复用 stage.start 类型，不影响判定', () => {
    expect(interruptedStage([ev('stage.start', 'implement'), ev('stage.start', 'implement'), ev('stage.end', 'implement')])).toBeNull();
    expect(interruptedStage([ev('stage.start', 'implement'), ev('stage.start', 'implement')])).toBe('implement');
  });

  it('空事件流（如 LS-002 的事件日志曾丢失）→ 不算中断', () => {
    expect(interruptedStage([])).toBeNull();
  });
});

describe('重启后失效的待答卡片（OP-001 事故回归：clarify 提了 4 问后重启，卡片全哑没人说）', () => {
  it('最后的生命周期事件是 question.asked / gate.asked → 报出摘要', () => {
    expect(lostPendingCards([ev('stage.start', 'clarify'), ev('stage.end', 'clarify'), ev('question.asked', 'clarify')])).toBe('s');
    expect(lostPendingCards([ev('stage.end', 'review'), ev('gate.asked', 'review')])).toBe('s');
  });
  it('已答完 / 阶段已推进 / 已闭环 → 不误报；备注类事件不干扰判定', () => {
    expect(lostPendingCards([ev('question.asked'), ev('question.answered')])).toBeNull();
    expect(lostPendingCards([ev('gate.asked'), ev('gate.answered'), ev('stage.start', 'ci')])).toBeNull();
    expect(lostPendingCards([ev('question.asked'), ev('human.message')])).toBe('s'); // note 不算应答
    expect(lostPendingCards([ev('stage.end'), ev('done')])).toBeNull();
    expect(lostPendingCards([])).toBeNull();
  });
  it('7 天以上的死卡不点名（LS-011 实测：作废工单的旧提问每次开机被唠叨）', () => {
    const old = { ...ev('question.asked'), ts: new Date(Date.now() - 8 * 86400000).toISOString() };
    expect(lostPendingCards([old])).toBeNull();
  });
});

describe('结果预览静态路由（内网只读服务，路径穿越是第一杀手）', () => {
  const repoOf = (t: string): string | null => (t === 'OP-002' ? 'D:/work/odoo-product' : null);

  it('工单根路径回落 index.html；子资源按相对路径解析', () => {
    expect(previewLocalPath('/preview/OP-002/', repoOf)).toBe('D:\\work\\odoo-product\\docs\\pipeline\\OP-002\\prototype\\index.html');
    expect(previewLocalPath('/preview/OP-002', repoOf)).toContain('index.html');
    expect(previewLocalPath('/preview/OP-002/img/a.png', repoOf)).toContain('prototype\\img\\a.png');
  });

  it('路径穿越、非法工单号、未知工单一律 null', () => {
    expect(previewLocalPath('/preview/OP-002/../../../.env', repoOf)).toBeNull();
    expect(previewLocalPath('/preview/OP-002/%2e%2e/secret', repoOf)).toBeNull();
    expect(previewLocalPath('/preview/OP-002/a\\b.html', repoOf)).toBeNull();
    expect(previewLocalPath('/preview/<bad>/x', repoOf)).toBeNull();
    expect(previewLocalPath('/preview/LS-999/', repoOf)).toBeNull();
    expect(previewLocalPath('/gitlab', repoOf)).toBeNull();
  });

  it('Content-Type 按扩展名，未知类型按下载', () => {
    expect(previewContentType('a.html')).toContain('text/html');
    expect(previewContentType('a.svg')).toBe('image/svg+xml');
    expect(previewContentType('a.exe')).toBe('application/octet-stream');
  });

  it('previewUrl：配了 PREVIEW_BASE_URL 才给链接，尾斜杠归一', () => {
    expect(previewUrl('OP-002', { PREVIEW_BASE_URL: 'http://10.0.0.5:8377/' } as NodeJS.ProcessEnv)).toBe('http://10.0.0.5:8377/preview/OP-002/');
    expect(previewUrl('OP-002', {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

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
