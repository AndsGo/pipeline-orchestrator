import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureIntake } from '../ticketRunner.js';

const T = 'INTAKE-TEST';
let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  // ensureIntake 会记 ticket.created 事件——清掉测试工单的事件文件，别污染 listTickets
  fs.rmSync(new URL(`../../data/${T}.events.jsonl`, import.meta.url), { force: true });
});

const intakeDoc = (): string => fs.readFileSync(path.join(repo, 'docs/pipeline', T, '00-intake.md'), 'utf-8');

describe('ensureIntake 的建单附带（LS-013 教训：排查结论必须跟着需求走，note 事件 80 字截断装不下）', () => {
  it('附带的 /run 排查记录整段写进 00-intake.md', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
    ensureIntake(repo, T, '修复全站布局裁切', '以下是建单前最近一次单次执行（/run）的记录\n14 处文件清单…');
    expect(intakeDoc()).toContain('修复全站布局裁切');
    expect(intakeDoc()).toContain('## 建单前的执行记录（自动附带，供参考）');
    expect(intakeDoc()).toContain('14 处文件清单');
  });

  it('不带 context 时不出现空附录节', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
    ensureIntake(repo, T, '修复全站布局裁切');
    expect(intakeDoc()).not.toContain('建单前的执行记录');
  });

  it('已存在的 intake 不被覆盖——续跑再传 context 也没有副作用', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
    ensureIntake(repo, T, '原始需求');
    ensureIntake(repo, T, '原始需求', '新的附录');
    expect(intakeDoc()).not.toContain('新的附录');
  });
});
