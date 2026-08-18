import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptViaMr,
  applyClaudeMdSuggestions,
  readSuggestions,
  renderSuggestionsDetail,
  SUGGESTIONS_FILE,
} from '../suggestions.js';

let repo: string;
const TICKET = 'LS-999';

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sugg-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function writeSuggestionsFile(content: string): void {
  const dir = path.join(repo, 'docs', 'pipeline', TICKET);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SUGGESTIONS_FILE), content, 'utf-8');
}

describe('readSuggestions', () => {
  it('文件缺失 = 无建议，不是错误', () => {
    const { suggestions, error } = readSuggestions(repo, TICKET);
    expect(error).toBeUndefined();
    expect(suggestions.claudeMd).toEqual([]);
    expect(suggestions.process).toEqual([]);
  });

  it('读出合法的两类建议', () => {
    writeSuggestionsFile(
      JSON.stringify({
        claudeMd: [{ section: '## 环境', line: '- 本机 Docker daemon 通常未运行', why: '被独立发现 7+ 次' }],
        process: [{ skill: 'pipeline-acceptance', suggestion: '不通过必须附失败现象' }],
      }),
    );
    const { suggestions, error } = readSuggestions(repo, TICKET);
    expect(error).toBeUndefined();
    expect(suggestions.claudeMd).toHaveLength(1);
    expect(suggestions.process).toHaveLength(1);
  });

  it('JSON 语法错误返回 error，不静默吞掉', () => {
    writeSuggestionsFile('{ claudeMd: [ 缺引号');
    const { suggestions, error } = readSuggestions(repo, TICKET);
    expect(error).toBeTruthy();
    expect(suggestions.claudeMd).toEqual([]);
  });

  it('过滤畸形条目：section 必须是标题、line 不能为空', () => {
    writeSuggestionsFile(
      JSON.stringify({
        claudeMd: [
          { section: '环境', line: '- 缺 # 前缀' },
          { section: '## 环境', line: '   ' },
          { section: '## 环境', line: '- 合法条目' },
        ],
        process: [{ skill: 'x', suggestion: '' }],
      }),
    );
    const { suggestions } = readSuggestions(repo, TICKET);
    expect(suggestions.claudeMd).toHaveLength(1);
    expect(suggestions.claudeMd[0].line).toBe('- 合法条目');
    expect(suggestions.process).toHaveLength(0);
  });

  it('缺 claudeMd/process 键时按空数组处理', () => {
    writeSuggestionsFile('{}');
    const { suggestions, error } = readSuggestions(repo, TICKET);
    expect(error).toBeUndefined();
    expect(suggestions.claudeMd).toEqual([]);
  });
});

describe('applyClaudeMdSuggestions', () => {
  it('追加到既有小节末尾（下一个标题之前，跳过尾部空行）', () => {
    fs.writeFileSync(
      path.join(repo, 'CLAUDE.md'),
      '# 项目说明\n\n## 环境\n\n- 已有一条\n\n## 构建\n\n- pnpm build\n',
      'utf-8',
    );
    const r = applyClaudeMdSuggestions(repo, [{ section: '## 环境', line: '- 本机 Docker daemon 通常未运行' }]);
    expect(r.applied).toHaveLength(1);
    const content = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
    const envIdx = content.indexOf('- 本机 Docker daemon');
    expect(envIdx).toBeGreaterThan(content.indexOf('- 已有一条'));
    expect(envIdx).toBeLessThan(content.indexOf('## 构建'));
  });

  it('小节不存在时在文件末尾新建', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 项目说明\n\n## 构建\n\n- pnpm build\n', 'utf-8');
    const r = applyClaudeMdSuggestions(repo, [{ section: '## 环境限制', line: '- 无 Docker daemon' }]);
    expect(r.applied).toHaveLength(1);
    const content = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
    expect(content).toMatch(/## 环境限制\n\n- 无 Docker daemon\n$/);
  });

  it('完全相同的行已存在时跳过（compound 重跑不堆重复）', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '## 环境\n\n- 无 Docker daemon\n', 'utf-8');
    const r = applyClaudeMdSuggestions(repo, [{ section: '## 环境', line: '- 无 Docker daemon' }]);
    expect(r.applied).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it('CLAUDE.md 不存在时创建', () => {
    const r = applyClaudeMdSuggestions(repo, [{ section: '## 环境', line: '- 无 Docker daemon' }]);
    expect(r.applied).toHaveLength(1);
    const content = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# CLAUDE.md');
    expect(content).toContain('## 环境');
  });

  it('多条建议同小节按序追加，且都能被后续查重命中', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '## 环境\n\n- 第一条\n', 'utf-8');
    const items = [
      { section: '## 环境', line: '- 第二条' },
      { section: '## 环境', line: '- 第三条' },
    ];
    const first = applyClaudeMdSuggestions(repo, items);
    expect(first.applied).toHaveLength(2);
    const second = applyClaudeMdSuggestions(repo, items);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
  });

  it('一条都没应用时文件内容不变', () => {
    const file = path.join(repo, 'CLAUDE.md');
    fs.writeFileSync(file, '## 环境\n\n- 唯一一条\n', 'utf-8');
    applyClaudeMdSuggestions(repo, [{ section: '## 环境', line: '- 唯一一条' }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('## 环境\n\n- 唯一一条\n');
  });
});

describe('adoptViaMr（专用分支 + MR 机制，真实 git）', () => {
  function run(cwd: string, args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
    return r.stdout ?? '';
  }

  /** bare origin + 克隆，主工作区检出在别的分支（复现 LS-005 场景） */
  function setup(ticketBranch: string): { root: string; origin: string; clone: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
    const origin = path.join(root, 'origin.git');
    const clone = path.join(root, 'clone');
    fs.mkdirSync(origin);
    run(origin, ['init', '--bare', '--initial-branch=master']);
    run(origin, ['config', 'receive.advertisePushOptions', 'true']);
    fs.mkdirSync(clone);
    run(clone, ['init', '--initial-branch=master']);
    run(clone, ['config', 'user.email', 't@t.t']);
    run(clone, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(clone, 'CLAUDE.md'), '## 环境\n\n- 已有常识\n', 'utf-8');
    run(clone, ['add', '.']);
    run(clone, ['commit', '-m', 'init']);
    run(clone, ['remote', 'add', 'origin', origin]);
    run(clone, ['push', '-u', 'origin', 'master']);
    run(clone, ['remote', 'set-head', 'origin', 'master']);
    run(clone, ['checkout', '-b', ticketBranch]);
    return { root, origin, clone };
  }

  it('从 origin 默认分支建临时分支合入推送；主工作区分支与文件不被触碰；临时资源清理干净', () => {
    const { root, origin, clone } = setup('feat/other');
    const r = adoptViaMr(clone, 'LS-9', [
      { section: '## 环境', line: '- 新常识' },
      { section: '## 环境', line: '- 已有常识' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['- 新常识']);
    expect(r.skipped).toEqual(['- 已有常识']);
    expect(run(origin, ['show', 'pipeline/claude-md-LS-9:CLAUDE.md'])).toContain('- 新常识');
    expect(run(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/other');
    expect(fs.readFileSync(path.join(clone, 'CLAUDE.md'), 'utf-8')).not.toContain('- 新常识');
    expect(run(clone, ['worktree', 'list'])).not.toContain('claude-md-LS-9');
    expect(run(clone, ['branch', '--list', 'pipeline/*']).trim()).toBe('');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('建议内容主干全有 → ok、applied 空、不产生远端分支', () => {
    const { root, origin, clone } = setup('feat/other2');
    const r = adoptViaMr(clone, 'LS-10', [{ section: '## 环境', line: '- 已有常识' }]);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual([]);
    const check = spawnSync('git', ['rev-parse', '--verify', 'refs/heads/pipeline/claude-md-LS-10'], {
      cwd: origin,
      encoding: 'utf-8',
    });
    expect(check.status).not.toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('renderSuggestionsDetail', () => {
  it('两类建议分区渲染，含依据', () => {
    const detail = renderSuggestionsDetail({
      claudeMd: [{ section: '## 环境', line: '- 无 Docker', why: '发现 7 次' }],
      process: [{ skill: 'pipeline-acceptance', suggestion: '不通过附现象' }],
    });
    expect(detail).toContain('自动合入');
    expect(detail).toContain('## 环境 ← - 无 Docker');
    expect(detail).toContain('依据：发现 7 次');
    expect(detail).toContain('[pipeline-acceptance] 不通过附现象');
  });
});
