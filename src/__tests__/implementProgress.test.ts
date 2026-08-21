import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countLedgerDone,
  countPlanTasks,
  decideAutoContinue,
  type ImplementProgress,
  readImplementProgress,
} from '../implementProgress.js';

/** 夹具取自 LS-012 真实台账与计划的行格式 */
const PLAN = `---
stage: plan
status: DONE_WITH_CONCERNS
---

### Task 1: open_api_log 组织架构快照字段（覆盖：AC-1）

- [ ] **Step 1: 写失败测试**

### Task 2: 部门快照解析（覆盖：AC-3）

### Task 3: 埋点接线（覆盖：AC-4）
`;

const LEDGER_TWO_ROUNDS = `# SDD ledger

### Task 1
- Task 1: fix round 1/5 (2 addressed, 0 open; commits 85e8b92..6dc3aa5)
- Task 1: complete (commits 3f3dd6c..6dc3aa5, review clean)

### Task 2
- Task 2: implementation complete, review pending
- Task 2: **任务评审未跑**（会话预算耗尽于此），因此**不写 complete 行**
`;

const tmpdirs: string[] = [];
function repoWith(files: Record<string, string>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'implprog-'));
  tmpdirs.push(repo);
  const dir = path.join(repo, 'docs', 'pipeline', 'LS-012');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf-8');
  return repo;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('计划任务数与台账完成数', () => {
  it('数计划里的 ### Task N 标题', () => {
    expect(countPlanTasks(PLAN)).toBe(3);
    expect(countPlanTasks('没有任务标题')).toBe(0);
  });

  it('只把 complete 行算完成——「implementation complete, review pending」不算', () => {
    expect(countLedgerDone(LEDGER_TWO_ROUNDS)).toBe(1);
  });

  it('同一任务的多条 complete 行只算一次（修复轮会重复写）', () => {
    expect(countLedgerDone('- Task 1: complete (a)\n- Task 1: complete (b)\n- Task 2: complete\n')).toBe(2);
  });

  it('读盘：计划/台账缺失时给 0，不抛', () => {
    expect(readImplementProgress(repoWith({}), 'LS-012')).toEqual({ done: 0, total: 0, ledgerLines: 0 });
    const repo = repoWith({ '20-plan.md': PLAN, 'ledger.md': LEDGER_TWO_ROUNDS });
    const p = readImplementProgress(repo, 'LS-012');
    expect(p).toMatchObject({ done: 1, total: 3 });
    expect(p.ledgerLines).toBeGreaterThan(5);
  });
});

describe('自动续跑判据', () => {
  const prog = (over: Partial<ImplementProgress> = {}): ImplementProgress => ({
    done: 1,
    total: 9,
    ledgerLines: 100,
    ...over,
  });

  it('有进展 + 还有任务 → 续跑，理由里带进度与批次', () => {
    const d = decideAutoContinue({ before: prog({ done: 0, ledgerLines: 60 }), now: prog(), used: 1, cap: 5 });
    expect(d.ok).toBe(true);
    expect(d.reason).toContain('1/9');
    expect(d.reason).toContain('第 2/5 批');
  });

  it('完成数没变但台账在长（评审补跑、fix round）也算进展', () => {
    expect(decideAutoContinue({ before: prog({ ledgerLines: 80 }), now: prog(), used: 0, cap: 5 }).ok).toBe(true);
  });

  it('台账零增长 → 不续跑（确定性失败的空转特征）', () => {
    const d = decideAutoContinue({ before: prog(), now: prog(), used: 0, cap: 5 });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('零增长');
  });

  it('任务已全做完 → 挂起另有原因，不续跑', () => {
    const d = decideAutoContinue({ before: prog({ done: 8 }), now: prog({ done: 9 }), used: 0, cap: 5 });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('全部完成');
  });

  it('读不到任务总数 → 不猜', () => {
    expect(decideAutoContinue({ before: prog(), now: prog({ total: 0 }), used: 0, cap: 5 }).ok).toBe(false);
  });

  it('用满上限 → 转人工，理由带上限与当前进度', () => {
    const d = decideAutoContinue({ before: prog({ done: 0 }), now: prog({ done: 4 }), used: 5, cap: 5 });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('5 批');
    expect(d.reason).toContain('4/9');
  });

  it('无基线（本进程没跑过 implement）→ 不续跑', () => {
    expect(decideAutoContinue({ now: prog(), used: 0, cap: 5 }).ok).toBe(false);
  });
});
