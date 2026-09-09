import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KB_STATUSES } from '../bitable/schema.js';
import { activeOnly, type KnowledgeEntry } from '../knowledge.js';
import { flagStaleHints, mergeStaleHints, reviewStaleHints } from '../run/compound.js';
import type { InteractionPort } from '../ports.js';
import { validateResult } from '../schema.js';

const entry = (title: string, status?: string): KnowledgeEntry => ({
  title,
  kind: '踩坑',
  status,
  tags: [],
  symptom: '',
  cause: '',
  practice: 'x',
});

describe('契约 0.12.0：stale_hints（阶段回报过时知识）', () => {
  const base = { stage: 'plan', status: 'DONE', handoff_path: 'docs/pipeline/T/20-plan.md', summary_for_card: 's' };
  it('可选字段，字符串数组通过回程校验；空串被拒', () => {
    expect(validateResult(base)).toEqual([]);
    expect(validateResult({ ...base, stale_hints: ['某条知识标题'] })).toEqual([]);
    expect(validateResult({ ...base, stale_hints: [''] }).length).toBeGreaterThan(0);
  });

  it('「待复核」是合法状态，且不参与注入（停注入靠 activeOnly 只放行「生效」）', () => {
    expect(KB_STATUSES).toContain('待复核');
    const out = activeOnly([entry('a', '生效'), entry('b', '待复核')]);
    expect(out.map((e) => e.title)).toEqual(['a']);
  });

  it('mergeStaleHints：跨阶段累计去重、去空白', () => {
    expect(mergeStaleHints(undefined, ['a', ' b ', '', 'a'])).toEqual(['a', 'b']);
    expect(mergeStaleHints(['a'], ['b', 'a'])).toEqual(['a', 'b']);
  });

  it('未配知识表时：flag 不动、不通知；review 无待复核时不发卡', async () => {
    // 事件文件走临时目录：别把 TEST 工单的 events 写进真 data/（监控会把它当真事件播报）
    process.env.PIPELINE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-hints-'));
    const calls: string[] = [];
    const port = {
      notify: async (_t: string, m: string) => void calls.push(`notify:${m.slice(0, 10)}`),
      confirmGate: async () => {
        calls.push('gate');
        return { approved: true };
      },
    } as unknown as InteractionPort;
    // BITABLE_* 未配 → markKnowledge 返回空 → 全部算「没找到」，仍要告知群（否则人不知道模型报了什么）
    const flagged = await flagStaleHints('T-1', 'plan', ['x'], port);
    expect(flagged).toEqual([]);
    expect(calls.some((c) => c.startsWith('notify:'))).toBe(true);
    await reviewStaleHints('T-1', port, undefined);
    await reviewStaleHints('T-1', port, []);
    expect(calls).not.toContain('gate');
  });
});
