import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectCfgFromEnv } from '../bitable/sync.js';
import {
  normalizeGitlabPath,
  normalizeWikiToken,
  pipelineDocsIgnored,
  projectsJsonWith,
  readEnvVar,
  upsertEnvVar,
  validateNewProject,
} from '../onboarding.js';

describe('pipelineDocsIgnored（odoo-product 实测：.gitignore 整行 docs，工件全部不入库）', () => {
  it('屏蔽 docs 的仓库 → true；正常仓库 → false；非 git 目录 → false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ign-'));
    try {
      execSync('git init -q', { cwd: dir, stdio: 'ignore' });
      expect(pipelineDocsIgnored(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'docs\n', 'utf-8');
      expect(pipelineDocsIgnored(dir)).toBe(true);
      // git 语义：父目录整个被忽略时 !docs/pipeline/ 放不开；正确写法是 docs/* + !docs/pipeline/
      fs.writeFileSync(path.join(dir, '.gitignore'), 'docs/*\n!docs/pipeline/\n', 'utf-8');
      expect(pipelineDocsIgnored(dir)).toBe(false);
      expect(pipelineDocsIgnored(os.tmpdir())).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
import type { Project } from '../projects.js';

const existing: Project[] = [{ alias: 'lakeghost', repo: 'D:/work/lake_spirit', prefix: 'LS' }];

describe('validateNewProject', () => {
  it('合法候选通过', () => {
    expect(validateNewProject(existing, { alias: 'foo', repo: 'D:/work/foo', prefix: 'FO' })).toEqual([]);
  });
  it('别名/前缀冲突都拦（前缀冲突会把工单派错仓库）', () => {
    const errs = validateNewProject(existing, { alias: 'LAKEGHOST', repo: 'D:/x', prefix: 'ls' });
    expect(errs.some((e) => e.includes('别名'))).toBe(true);
    expect(errs.some((e) => e.includes('lakeghost'))).toBe(true);
  });
  it('格式校验：别名要字母开头，前缀 1-6 个纯字母', () => {
    expect(validateNewProject(existing, { alias: '1foo', repo: 'D:/x', prefix: 'F0' })).toHaveLength(2);
    expect(validateNewProject(existing, { alias: 'foo', repo: '', prefix: 'TOOLONGX' }).length).toBe(2);
  });
});

describe('.env 文本编辑（凭据文件：只动目标行，其余字节原样保留）', () => {
  const env = '# 注释\nFEISHU_APP_ID=cli_xxx\nPIPELINE_PROJECTS={"a":{"repo":"D:/a"}}\nGITLAB_URL=http://g\n';
  it('readEnvVar 读值、跳过注释、不存在返回 null', () => {
    expect(readEnvVar(env, 'GITLAB_URL')).toBe('http://g');
    expect(readEnvVar('# GITLAB_URL=fake\n', 'GITLAB_URL')).toBeNull();
    expect(readEnvVar(env, 'NOPE')).toBeNull();
  });
  it('upsertEnvVar 只改目标行，其余行（含注释与凭据）原样', () => {
    const out = upsertEnvVar(env, 'PIPELINE_PROJECTS', '{"a":{},"b":{}}');
    expect(out).toContain('PIPELINE_PROJECTS={"a":{},"b":{}}');
    expect(out).toContain('# 注释');
    expect(out).toContain('FEISHU_APP_ID=cli_xxx');
    expect(out).toContain('GITLAB_URL=http://g');
  });
  it('不存在时追加；CRLF 文件保持 CRLF', () => {
    const crlf = 'A=1\r\nB=2\r\n';
    const out = upsertEnvVar(crlf, 'C', '3');
    expect(out).toContain('\r\nC=3');
    expect(out.includes('\nC=3\n') && !out.includes('\r\nC=3')).toBe(false);
  });
  it('projectsJsonWith 并入新项目：单行、可反解析、可选字段不写空值', () => {
    const next = projectsJsonWith('{"lakeghost":{"repo":"D:/work/lake_spirit","prefix":"LS"}}', {
      alias: 'foo',
      repo: 'D:\\work\\foo',
      prefix: 'fo',
      gitlab: 'g/foo',
    });
    expect(next).not.toContain('\n');
    const parsed = JSON.parse(next) as Record<string, { repo: string; prefix: string; jenkins?: string }>;
    expect(parsed.foo).toEqual({ repo: 'D:/work/foo', prefix: 'FO', gitlab: 'g/foo' });
    expect(parsed.lakeghost.prefix).toBe('LS');
  });
});

describe('宽容输入剥壳（nova 接入实测：人就是会粘完整 URL）', () => {
  it('clone URL / 带 .git / 已是路径，三种输入同一结果', () => {
    expect(normalizeGitlabPath('http://git.happotech.com/songxulin/nova.git')).toBe('songxulin/nova');
    expect(normalizeGitlabPath('songxulin/nova.git')).toBe('songxulin/nova');
    expect(normalizeGitlabPath('songxulin/nova')).toBe('songxulin/nova');
  });
  it('wiki 页面 URL / 裸 token，两种输入同一结果', () => {
    expect(normalizeWikiToken('https://euj0e90can.feishu.cn/wiki/UWRGw3pb5iPVsPk01DEcGnTYn7d')).toBe('UWRGw3pb5iPVsPk01DEcGnTYn7d');
    expect(normalizeWikiToken('UWRGw3pb5iPVsPk01DEcGnTYn7d')).toBe('UWRGw3pb5iPVsPk01DEcGnTYn7d');
  });
  it('projectsJsonWith 落盘的是剥壳后的值', () => {
    const parsed = JSON.parse(
      projectsJsonWith('{}', {
        alias: 'nova',
        repo: 'D:/work/nova',
        prefix: 'NV',
        gitlab: 'http://git.happotech.com/songxulin/nova.git',
        wikiArchive: 'https://x.feishu.cn/wiki/UWRGw3pb5iPVsPk01DEcGnTYn7d',
      }),
    ) as Record<string, { gitlab: string; wikiArchive: string }>;
    expect(parsed.nova.gitlab).toBe('songxulin/nova');
    expect(parsed.nova.wikiArchive).toBe('UWRGw3pb5iPVsPk01DEcGnTYn7d');
  });
});

describe('GitLab 映射收敛为一处（2026-08-26）', () => {
  it('PIPELINE_PROJECTS 的 gitlab 字段直供看板链接，不再必须配 GITLAB_REPO_MAP', () => {
    const cfg = projectCfgFromEnv({
      PIPELINE_PROJECTS: '{"foo":{"repo":"D:/work/foo","prefix":"FO","gitlab":"g/foo"}}',
      GITLAB_URL: 'http://g',
    } as NodeJS.ProcessEnv);
    expect(cfg.repoToProject?.['D:/work/foo']).toBe('g/foo');
  });
  it('存量 GITLAB_REPO_MAP 仍可用，两处同配时 PIPELINE_PROJECTS 优先', () => {
    const cfg = projectCfgFromEnv({
      PIPELINE_PROJECTS: '{"foo":{"repo":"D:/work/foo","prefix":"FO","gitlab":"new/foo"}}',
      GITLAB_REPO_MAP: '{"old/foo":"D:\\\\work\\\\foo","legacy/bar":"D:/work/bar"}',
    } as NodeJS.ProcessEnv);
    expect(cfg.repoToProject?.['D:/work/foo']).toBe('new/foo');
    expect(cfg.repoToProject?.['D:/work/bar']).toBe('legacy/bar');
  });
});
