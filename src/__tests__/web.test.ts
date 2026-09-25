import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebServer, mountRoutes } from '../web/server.js';

/** web 服务的挂载规则：缺哪组配置就不挂哪组，但服务照样起来；预览永远在 */
const GITLAB = { GITLAB_URL: 'http://git', GITLAB_API_TOKEN: 't', GITLAB_WEBHOOK_SECRET: 'sek', GITLAB_REPO_MAP: '{"g/p":"/r"}' };
let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve(env: NodeJS.ProcessEnv): Promise<string> {
  const server = createWebServer(mountRoutes(env, () => {}));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('web 服务挂载', () => {
  it('全配齐：三组都挂，各自的鉴权互不串', async () => {
    const m = mountRoutes({ ...GITLAB, CONSOLE_TOKEN: 'long-enough' }, () => {});
    expect(m.routes).toHaveLength(3);
    const base = await serve({ ...GITLAB, CONSOLE_TOKEN: 'long-enough' });
    expect((await fetch(`${base}/gitlab`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/gitlab`, { method: 'POST', headers: { 'x-gitlab-token': 'sek' }, body: '{}' })).status).toBe(200);
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    // 控制台的口令换不来 GitLab 的放行
    expect((await fetch(`${base}/gitlab`, { method: 'POST', headers: { 'x-gitlab-token': 'long-enough' } })).status).toBe(401);
    // 编码过的穿越（fetch 不会替我们规范化）由预览路由自己挡
    expect((await fetch(`${base}/preview/OP-1/..%2F..%2F..%2F.env`)).status).toBe(404);
  });

  it('没配 GitLab：/gitlab 不挂，落到控制台兜底（登录页，不是 GitLab 的 ok），控制台照常', async () => {
    const m = mountRoutes({ CONSOLE_TOKEN: 'long-enough' }, () => {});
    expect(m.summary.join()).toMatch(/\/gitlab 未挂/);
    const base = await serve({ CONSOLE_TOKEN: 'long-enough' });
    const r = await fetch(`${base}/gitlab`, { method: 'POST', headers: { 'x-gitlab-token': 'sek' } });
    expect(await r.text()).toContain('流水线控制台');
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
  });

  it('口令缺失或太短：控制台不挂，其余路径 404 而不是登录页', async () => {
    expect(mountRoutes({ CONSOLE_TOKEN: 'short' }, () => {}).summary.join()).toMatch(/不足 8 位/);
    const base = await serve({ ...GITLAB });
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/overview`)).status).toBe(404);
  });
});
