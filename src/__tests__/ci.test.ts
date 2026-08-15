import { describe, expect, it } from 'vitest';
import { jobPath, resolveBuildNumber, runJenkinsBuild, triggerBuild, type JenkinsConfig } from '../jenkins.js';
import { route } from '../machine.js';
import type { StageResult, TicketState } from '../types.js';

const cfg: JenkinsConfig = { url: 'http://j', job: 'deploy/app', user: 'u', token: 't', timeoutMin: 1 };

function state(over: Partial<TicketState> = {}): TicketState {
  return {
    ticket: 'T-1',
    repo: '/repo',
    cursor: 'review',
    reviewFixRounds: 0,
    acceptanceFixRounds: 0,
    pendingReverify: null,
    runs: [],
    ...over,
  };
}

function res(over: Partial<StageResult>): StageResult {
  return { stage: 'review', status: 'DONE', handoff_path: 'p', summary_for_card: 's', ...over };
}

describe('状态机：ci 阶段路由', () => {
  it('review PASS + ciEnabled → 上线审批 gate → ci', () => {
    const a = route(state({ ciEnabled: true }), res({ verdict: 'PASS' }));
    expect(a).toMatchObject({ kind: 'gate', gate: 'deploy-approval', then: 'ci' });
  });

  it('review PASS 未配 CI → 直达 acceptance（原路径不变）', () => {
    expect(route(state(), res({ verdict: 'PASS' }))).toMatchObject({ kind: 'run', stage: 'acceptance' });
  });

  it('ci DONE → acceptance；ci BLOCKED → halt（通用分支）', () => {
    expect(route(state({ cursor: 'ci', ciEnabled: true }), res({ stage: 'ci' }))).toMatchObject({
      kind: 'run',
      stage: 'acceptance',
    });
    expect(
      route(state({ cursor: 'ci', ciEnabled: true }), res({ stage: 'ci', status: 'BLOCKED', blocked_reason: 'FAILURE' })),
    ).toMatchObject({ kind: 'halt', reason: 'FAILURE' });
  });

  it('ciEnabled 不影响 review BLOCK 的修复回环', () => {
    const a = route(state({ ciEnabled: true }), res({ verdict: 'BLOCK', handoff_path: 'docs/pipeline/T-1/30-review-r1.md' }));
    expect(a).toMatchObject({ kind: 'fix', reverify: 'review' });
  });
});

describe('Jenkins 模块（注入 fetch，不触网）', () => {
  it('jobPath 支持 folder 形式', () => {
    expect(jobPath('deploy/app')).toBe('job/deploy/job/app');
    expect(jobPath('single')).toBe('job/single');
  });

  it('triggerBuild：201 + Location → queue URL；参数与认证进请求', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { status: 201, headers: new Headers({ location: 'http://j/queue/item/42/' }) } as Response;
    }) as unknown as typeof fetch;

    const q = await triggerBuild(cfg, { TICKET: 'T-1', BRANCH: 'feat/x' }, fake);
    expect(q).toBe('http://j/queue/item/42');
    expect(calls[0].url).toBe('http://j/job/deploy/job/app/buildWithParameters?TICKET=T-1&BRANCH=feat%2Fx');
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('triggerBuild：无参数任务 buildWithParameters 500 → 回退 /build（实测 Jenkins 2.516 行为）', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes('buildWithParameters'))
        return { status: 500, text: async () => 'param-less', headers: new Headers() } as Response;
      return { status: 201, headers: new Headers({ location: 'http://j/queue/item/9/' }) } as Response;
    }) as unknown as typeof fetch;
    const q = await triggerBuild(cfg, { TICKET: 'T' }, fake);
    expect(q).toBe('http://j/queue/item/9');
    expect(calls[1]).toBe('http://j/job/deploy/job/app/build');
  });

  it('triggerBuild：非 201 → 抛错', async () => {
    const fake = (async () => ({ status: 403, text: async () => 'forbidden', headers: new Headers() })) as unknown as typeof fetch;
    await expect(triggerBuild(cfg, {}, fake)).rejects.toThrow('403');
  });

  it('resolveBuildNumber：先 pending 后 executable', async () => {
    let n = 0;
    const fake = (async () => ({
      ok: true,
      json: async () => (++n < 2 ? {} : { executable: { number: 7, url: 'http://j/job/deploy/job/app/7/' } }),
    })) as unknown as typeof fetch;
    const b = await resolveBuildNumber(cfg, 'http://j/queue/item/42', fake, 1);
    expect(b.number).toBe(7);
  });

  it('runJenkinsBuild：FAILURE → ok=false 且带日志尾部', async () => {
    const fake = (async (url: string) => {
      if (url.includes('buildWithParameters'))
        return { status: 201, headers: new Headers({ location: 'http://j/queue/item/1' }) } as Response;
      if (url.includes('/queue/'))
        return { ok: true, json: async () => ({ executable: { number: 3, url: 'http://j/b/3/' } }) } as Response;
      if (url.endsWith('api/json')) return { ok: true, json: async () => ({ building: false, result: 'FAILURE' }) } as Response;
      if (url.endsWith('consoleText')) return { ok: true, text: async () => 'x'.repeat(5000) + 'TAIL_MARK' } as Response;
      throw new Error('unexpected ' + url);
    }) as unknown as typeof fetch;

    const r = await runJenkinsBuild(cfg, {}, fake);
    expect(r).toMatchObject({ ok: false, buildNumber: 3, result: 'FAILURE' });
    expect(r.logTail.endsWith('TAIL_MARK')).toBe(true);
    expect(r.logTail.length).toBeLessThanOrEqual(4001);
  });

  it('runJenkinsBuild：触发失败 → TRIGGER_FAILED 不抛出', async () => {
    const fake = (async () => ({ status: 500, text: async () => 'boom', headers: new Headers() })) as unknown as typeof fetch;
    const r = await runJenkinsBuild(cfg, {}, fake);
    expect(r).toMatchObject({ ok: false, result: 'TRIGGER_FAILED', buildNumber: null });
  });
});
