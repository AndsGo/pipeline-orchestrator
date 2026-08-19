import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeFollowupPrompt,
  describeLastRun,
  FOLLOWUP_TTL_MS,
  readLastRun,
  saveLastRun,
  type LastRun,
} from '../followup.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-'));
  file = path.join(dir, 'last-run.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mkRun(over: Partial<LastRun> = {}): LastRun {
  return {
    at: new Date().toISOString(),
    project: 'lakeghost',
    command: '合并 LS-009 到 master',
    output: '已合并。还有两件事需要你确认：\n1. 是否 push 到远程\n2. 未跟踪目录 do 怎么处理',
    chain: 0,
    ...over,
  };
}

describe('saveLastRun / readLastRun', () => {
  it('落盘后能原样读回', () => {
    const r = mkRun();
    saveLastRun(r, file);
    expect(readLastRun(Date.now(), file)).toEqual(r);
  });

  it('无记录返回 null，不抛', () => {
    expect(readLastRun(Date.now(), file)).toBeNull();
  });

  it('文件损坏返回 null，不抛', () => {
    fs.writeFileSync(file, '{oops', 'utf-8');
    expect(readLastRun(Date.now(), file)).toBeNull();
  });

  it('超过 TTL 视同无记录——隔天回「1」大概率不是在回上次的问题', () => {
    const at = new Date().toISOString();
    saveLastRun(mkRun({ at }), file);
    expect(readLastRun(Date.parse(at) + FOLLOWUP_TTL_MS + 1, file)).toBeNull();
    expect(readLastRun(Date.parse(at) + FOLLOWUP_TTL_MS - 1, file)).not.toBeNull();
  });
});

describe('composeFollowupPrompt', () => {
  it('拼入上次任务、上次输出与本次答复', () => {
    const p = composeFollowupPrompt(mkRun(), '1 要 push；2 目录删掉');
    expect(p).toContain('合并 LS-009 到 master');
    expect(p).toContain('是否 push 到远程');
    expect(p).toContain('1 要 push；2 目录删掉');
  });

  it('超长输出截头保尾——收尾问题在末尾', () => {
    const tail = '结尾问题：是否 push？';
    const r = mkRun({ output: 'x'.repeat(30_000) + tail });
    const p = composeFollowupPrompt(r, '要');
    expect(p).toContain('已截断');
    expect(p).toContain(tail);
    expect(p.length).toBeLessThan(25_000);
  });
});

describe('describeLastRun', () => {
  it('首轮：指令摘要 + 相对时间', () => {
    const at = new Date().toISOString();
    const s = describeLastRun(mkRun({ at }), Date.parse(at) + 5 * 60_000);
    expect(s).toContain('合并 LS-009 到 master');
    expect(s).toContain('5 分钟前');
    expect(s).not.toContain('续聊');
  });

  it('续轮标出轮次，超过一小时按小时说', () => {
    const at = new Date().toISOString();
    const s = describeLastRun(mkRun({ at, chain: 2 }), Date.parse(at) + 3 * 3_600_000);
    expect(s).toContain('续聊第 2 轮');
    expect(s).toContain('3 小时前');
  });
});
