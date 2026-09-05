import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProfile, profileTemplate, readProfile, releaseTargetBranch, stageBrief } from '../profile.js';
import { findOpenMr, gitlabApiFromEnv, mergeMr } from '../gitlab/release.js';

const ODOO = `---
testEnv: none
acceptor: ops
release: merge-develop
---
# odoo-product 流水线项目约定

## 全阶段
测试库用独立库 ut_<ticket>，不要全新安装。

## implement
夹具必须自建 account.info。

## acceptance
本项目无测试环境。
`;

describe('parseProfile（项目流程约定：一半给机器一半给会话）', () => {
  it('frontmatter 开关 + 按 ## 分节', () => {
    const p = parseProfile(ODOO);
    expect(p.testEnv).toBeNull();
    expect(p.acceptor).toBe('ops');
    expect(p.release).toBe('merge-develop');
    expect(p.sections['全阶段']).toContain('ut_<ticket>');
    expect(p.sections['implement']).toContain('account.info');
    expect(p.sections['acceptance']).toContain('无测试环境');
  });

  it('有测试环境时带地址与说明（值后可带 # 行内注释）；非法/缺失开关回保守默认（dev / none）', () => {
    const p = parseProfile('---\ntestEnv: http://10.0.0.5:8080   # 测试环境\ntestEnvNote: 用运营账号 ops01 登录\nrelease: yolo\n---\n## acceptance\n去任务中心。');
    expect(p.testEnv).toEqual({ url: 'http://10.0.0.5:8080', note: '用运营账号 ops01 登录' });
    expect(p.acceptor).toBe('dev');
    expect(p.release).toBe('none');
    expect(parseProfile('## 全阶段\n只有正文没有 frontmatter').testEnv).toBeNull();
  });

  it('CRLF 文件同样解析（Windows 编辑器默认）', () => {
    const p = parseProfile(ODOO.replace(/\n/g, '\r\n'));
    expect(p.release).toBe('merge-develop');
    expect(p.sections['implement']).toContain('account.info');
  });

  it('stageBrief：全阶段 + 本阶段，头部带开关解读；两者都没有 → null', () => {
    const p = parseProfile(ODOO);
    const b = stageBrief(p, 'implement')!;
    expect(b).toContain('ut_<ticket>');
    expect(b).toContain('account.info');
    expect(b).toContain('无（人工验收项将转上线后补验');
    expect(b).toContain('运营');
    expect(b).toContain('合入 develop');
    expect(stageBrief(parseProfile('---\nrelease: none\n---\n## review\nx'), 'plan')).toBeNull();
  });

  it('模板可被自己解析，默认开关保守（无测试环境 / 研发验收 / 不设上线）', () => {
    const p = parseProfile(profileTemplate('foo'));
    expect(p.testEnv).toBeNull();
    expect(p.acceptor).toBe('dev');
    expect(p.release).toBe('none');
    expect(Object.keys(p.sections)).toEqual(expect.arrayContaining(['全阶段', 'implement', 'acceptance', 'release']));
  });

  it('readProfile：没有文件 → null（旧行为不变）；有文件 → 解析', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
    try {
      expect(readProfile(dir)).toBeNull();
      fs.mkdirSync(path.join(dir, 'docs', 'pipeline'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', 'pipeline', 'PIPELINE.md'), ODOO, 'utf-8');
      expect(readProfile(dir)?.release).toBe('merge-develop');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releaseTargetBranch：merge-* 给分支名，其余 null', () => {
    expect(releaseTargetBranch('merge-develop')).toBe('develop');
    expect(releaseTargetBranch('merge-master')).toBe('master');
    expect(releaseTargetBranch('manual')).toBeNull();
    expect(releaseTargetBranch('none')).toBeNull();
  });
});

describe('GitLab 上线动作（注入 fetch，不打真网）', () => {
  const api = { url: 'http://git.x', apiToken: 't' };
  const mkFetch = (status: number, json: unknown, seen: string[]) =>
    (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  // 每次调用按序返回不同响应（测「合并 405 → 回查 MR 已 merged」这种两步交互）
  const mkFetchSeq = (steps: Array<{ status: number; json: unknown }>, seen: string[]) => {
    let i = 0;
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
      const s = steps[Math.min(i++, steps.length - 1)];
      return new Response(JSON.stringify(s.json), { status: s.status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  };

  it('findOpenMr：按源分支查开着的 MR，项目路径 URL 编码；无结果 → null', async () => {
    const seen: string[] = [];
    const mr = await findOpenMr(api, 'default/odoo-product', 'feat/OP-002-x', mkFetch(200, [{ iid: 808, web_url: 'http://git.x/mr/808', target_branch: 'develop', title: 't' }], seen));
    expect(mr).toEqual({ iid: 808, webUrl: 'http://git.x/mr/808', targetBranch: 'develop', title: 't' });
    expect(seen[0]).toContain('/projects/default%2Fodoo-product/merge_requests?state=opened&source_branch=feat%2FOP-002-x');
    expect(await findOpenMr(api, 'g/p', 'b', mkFetch(200, [], []))).toBeNull();
    expect(await findOpenMr(api, 'g/p', 'b', mkFetch(500, {}, []))).toBeNull();
  });

  it('mergeMr：PUT /merge；失败把 GitLab 的原话带回来（冲突/保护分支要人看得懂）', async () => {
    const seen: string[] = [];
    expect(await mergeMr(api, 'g/p', 808, mkFetch(200, { merge_commit_sha: 'abc' }, seen))).toEqual({ ok: true, sha: 'abc' });
    expect(seen[0]).toBe('PUT http://git.x/api/v4/projects/g%2Fp/merge_requests/808/merge');
    // 真失败：PUT 406 + 回查 MR 仍 opened → 失败，带原话与状态
    const bad = await mergeMr(api, 'g/p', 808, mkFetchSeq([{ status: 406, json: { message: 'Branch cannot be merged' } }, { status: 200, json: { state: 'opened' } }], []));
    expect(bad).toEqual({ ok: false, message: 'HTTP 406：Branch cannot be merged（MR 状态：opened）' });
  });

  it('mergeMr：PUT 返回 405 但 MR 其实已 merged（GitLab 异步合并，LS-015 实测）→ 判成功不误报', async () => {
    const seen: string[] = [];
    // 405 响应体自带 state:merged
    expect(await mergeMr(api, 'g/p', 19, mkFetch(405, { state: 'merged', merge_commit_sha: 'm1' }, seen))).toEqual({ ok: true, sha: 'm1' });
    // 405 响应体没说，回查 MR 得知已 merged
    const r = await mergeMr(api, 'g/p', 19, mkFetchSeq([{ status: 405, json: { message: 'Method Not Allowed' } }, { status: 200, json: { state: 'merged', merge_commit_sha: 'm2' } }], seen));
    expect(r).toEqual({ ok: true, sha: 'm2' });
  });

  it('gitlabApiFromEnv：缺 URL 或 token → null（上线卡仍发，只是没有自动合并）', () => {
    expect(gitlabApiFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(gitlabApiFromEnv({ GITLAB_URL: 'http://g/', GITLAB_API_TOKEN: 'x' } as NodeJS.ProcessEnv)).toEqual({ url: 'http://g', apiToken: 'x' });
  });
});
