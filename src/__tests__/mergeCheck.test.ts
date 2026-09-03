import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkMergeAgainstTarget, describeMergeCheck } from '../mergeCheck.js';

let root: string;
let origin: string;
let repo: string;
const sh = (cwd: string, cmd: string): string => execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mergecheck-'));
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  sh(root, `git init -q --bare "${origin}"`);
  sh(root, `git clone -q "${origin}" "${repo}"`);
  sh(repo, 'git config user.email t@t && git config user.name t && git checkout -q -b develop');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'base\n');
  sh(repo, 'git add . && git commit -q -m base && git push -q -u origin develop');
  sh(repo, 'git checkout -q -b feat/T-1');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('checkMergeAgainstTarget（合并前先拉目标分支最新代码、干跑合并查冲突）', () => {
  it('目标分支无新提交 → 已同步', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'feat\n');
    sh(repo, 'git commit -q -am feat');
    const c = checkMergeAgainstTarget(repo, 'feat/T-1', 'develop');
    expect(c).toMatchObject({ ok: true, upToDate: true });
    expect(describeMergeCheck(c, 'develop')).toContain('已同步');
  });

  it('目标分支有新提交但改的是别的文件 → 无冲突；改同一处 → 列出冲突文件', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'feat\n');
    sh(repo, 'git commit -q -am feat');
    // 远端 develop 前进：先改 b.txt（不冲突）
    const other = path.join(root, 'other');
    sh(root, `git clone -q -b develop "${origin}" "${other}"`);
    sh(other, 'git config user.email o@o && git config user.name o');
    fs.writeFileSync(path.join(other, 'b.txt'), 'other\n');
    sh(other, 'git commit -q -am other && git push -q origin develop');
    const clean = checkMergeAgainstTarget(repo, 'feat/T-1', 'develop');
    expect(clean).toMatchObject({ ok: true, upToDate: false });
    expect(describeMergeCheck(clean, 'develop')).toContain('无冲突');
    // 再改 a.txt（与工单分支冲突）
    fs.writeFileSync(path.join(other, 'a.txt'), 'conflict\n');
    sh(other, 'git commit -q -am conflict && git push -q origin develop');
    const bad = checkMergeAgainstTarget(repo, 'feat/T-1', 'develop');
    expect(bad).toMatchObject({ ok: false, conflicts: ['a.txt'] });
    expect(describeMergeCheck(bad, 'develop')).toContain('a.txt');
    // 干跑不动工作区与分支
    expect(sh(repo, 'git status --porcelain')).toBe('');
    expect(sh(repo, 'git rev-parse --abbrev-ref HEAD')).toBe('feat/T-1');
  });

  it('远端不可达 / 目标分支不存在 → unchecked，说明原因，不抛', () => {
    const c = checkMergeAgainstTarget(repo, 'feat/T-1', 'nope');
    expect(c.ok).toBe('unchecked');
    expect(describeMergeCheck(c, 'nope')).toContain('未能检查');
  });
});
