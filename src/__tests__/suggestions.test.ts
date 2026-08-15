import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
