import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commandDigest, describeSlashTarget, resolveSlashTarget, skillDigest, splitSlash } from '../slashTarget.js';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-target-'));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

fs.mkdirSync(path.join(repo, '.claude', 'commands'), { recursive: true });
fs.writeFileSync(
  path.join(repo, '.claude', 'commands', 'docker-push.md'),
  [
    'Build and push images.',
    '',
    '```bash',
    'cd /repo && \\',
    'docker build -t app:latest . && \\',
    'docker push registry.example.com/app:latest',
    '```',
    '',
    '## Notes',
    '- Ensure Docker Desktop is running.',
  ].join('\n'),
  'utf-8',
);
fs.mkdirSync(path.join(repo, '.claude', 'skills', 'lint-check'), { recursive: true });
fs.writeFileSync(
  path.join(repo, '.claude', 'skills', 'lint-check', 'SKILL.md'),
  ['---', 'name: lint-check', 'description: 只读跑一遍 lint 并汇总问题', '---', '', '# 步骤', '1. 跑 eslint'].join('\n'),
  'utf-8',
);

describe('斜杠指令解析（确认卡的决策材料）', () => {
  it('拆出指令名与参数', () => {
    expect(splitSlash('/docker-push')).toEqual({ name: 'docker-push', args: '' });
    expect(splitSlash('  /pipeline-implement LS-006 fix=x')).toEqual({
      name: 'pipeline-implement',
      args: 'LS-006 fix=x',
    });
    expect(splitSlash('运行 /docker-push')).toEqual({ name: '', args: '' });
  });

  it('命中项目指令：取 bash 块里的真实命令，并标出对外副作用', () => {
    const t = resolveSlashTarget(repo, '/docker-push');
    expect(t.kind).toBe('command');
    expect(t.origin).toBe('项目指令');
    expect(t.digest).toContain('docker push registry.example.com/app:latest');
    expect(t.digest).not.toContain('&& \\'); // 续行符去掉，卡片上才读得动
    expect(t.risks).toContain('推送镜像到远端仓库');
  });

  // 卡片上多报一条假风险，人就开始不信这张卡：Notes 里的"记得先 docker login"不算会执行
  it('风险只扫真正会执行的代码块，不扫说明文字', () => {
    fs.writeFileSync(
      path.join(repo, '.claude', 'commands', 'note-only.md'),
      ['```bash', 'npm test', '```', '', '## Notes', '- 先 docker login registry.example.com', '- 别忘了 git push'].join('\n'),
      'utf-8',
    );
    expect(resolveSlashTarget(repo, '/note-only').risks).toEqual([]);
  });

  it('命中项目 skill：摘要取 frontmatter 的 description', () => {
    const t = resolveSlashTarget(repo, '/lint-check');
    expect(t.kind).toBe('skill');
    expect(t.digest).toBe('只读跑一遍 lint 并汇总问题');
    expect(t.risks).toEqual([]);
  });

  // 实测踩坑：用户连着两次写 `docker_push`，模型跑了 4~5 轮、报告正常，实际什么都没执行
  it('名字写错时报出最接近的候选，而不是拿去让模型瞎猜', () => {
    const t = resolveSlashTarget(repo, '/docker_push');
    expect(t.kind).toBe('unknown');
    expect(t.suggestion).toBe('docker-push');
  });

  it('确实不存在时不硬凑候选', () => {
    const t = resolveSlashTarget(repo, '/zzz-nonexistent-thing');
    expect(t.kind).toBe('unknown');
    expect(t.suggestion).toBeUndefined();
  });

  it('确认卡写清：跑什么、什么副作用、取消无改动', () => {
    const text = describeSlashTarget(resolveSlashTarget(repo, '/docker-push'), 'lakeghost');
    expect(text).toContain('lakeghost');
    expect(text).toContain('推送镜像到远端仓库');
    expect(text).toContain('docker push registry.example.com/app:latest');
    expect(text).toContain('取消不会有任何改动');
  });

  it('摘要提取：命令去掉注释行，skill 无 frontmatter 时退化取首个正文行', () => {
    expect(commandDigest('# 注释\n```bash\nnpm test\n# 说明\n```')).toBe('npm test');
    expect(skillDigest('# 标题\n\n这是说明\n')).toBe('这是说明');
  });
});
