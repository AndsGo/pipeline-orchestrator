import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebServer, mountRoutes } from '../web/server.js';
import { applyBugAction, createBug } from '../bugs.js';

vi.mock('../console/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../console/api.js')>(),
  readProjectsView: () => ({ mtime: 0, projects: [{ alias: 'demo', repo: path.resolve('.'), prefix: 'DEMO' }] }),
}));

let dir: string, base: string, cookie: string;
let server: ReturnType<typeof createWebServer>;
const environment = { ...process.env };
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-route-'));
  process.env.PIPELINE_DATA_DIR = dir;
  server = createWebServer(mountRoutes({ CONSOLE_TOKEN: 'bug-test-token' }, () => {}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'bug-test-token' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  process.env = { ...environment };
  fs.rmSync(dir, { recursive: true, force: true });
});
const request = (url: string, method = 'GET', body?: unknown) => fetch(`${base}${url}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('bug console API', () => {
  it('requires an authenticated session', async () => {
    expect((await fetch(base + '/api/bugs')).status).toBe(401);
    expect((await fetch(base + '/api/bugs/BUG-001/actions', { method: 'POST' })).status).toBe(401);
  });
  it('rejects invalid and missing identifiers and arbitrary project paths', async () => {
    expect((await request('/api/bugs/not-valid')).status).toBe(400);
    expect((await request('/api/bugs/%2e%2e%2fsecret')).status).toBe(400);
    expect((await request('/api/bugs/BUG-999999')).status).toBe(404);
    expect((await request('/api/bugs', 'POST', { project: 'not-a-project', repo: dir, raw: '反馈', requester: '用户', requestId: 'request-123' })).status).toBe(400);
  });
  it('checks transitions, revision and idempotency and does not permit status patches', async () => {
    const bug = createBug({ project: 'demo', repo: dir, requester: '用户', raw: '反馈' });
    const url = `/api/bugs/${bug.id}`;
    expect((await request(url, 'PATCH', { status: '已关闭' })).status).toBe(405);
    expect((await request(url + '/actions', 'POST', { expectedRevision: 1, requestId: 'request-001', action: { type: 'verify-pass', round: 1, fixVersion: 'v1', deployedVersion: 'v1', evidenceRefs: ['验收'] } })).status).toBe(400);
    const body = { expectedRevision: 1, requestId: 'request-002', action: { type: 'triage', owner: '负责人' } };
    const first = await request(url + '/actions', 'POST', body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revision: 2, status: '待复现' });
    expect((await request(url + '/actions', 'POST', body)).status).toBe(200);
    expect((await request(url + '/actions', 'POST', { ...body, requestId: 'request-003' })).status).toBe(409);
    expect((await request(url + '/actions', 'POST', { expectedRevision: 2, requestId: 'request-004', action: { type: 'link-ticket', ticket: 'LS-001', token: 'forged' } })).status).toBe(400);
  });
  it('resolves the project on the server and reuses the registration request', async () => {
    const body = { project: 'demo', repo: dir, raw: '反馈', requester: '用户', requestId: 'create-001' };
    const first = await request('/api/bugs', 'POST', body);
    expect(first.status).toBe(201);
    const saved = await first.json();
    expect(saved.repo).toBe(path.resolve('.'));
    const again = await (await request('/api/bugs', 'POST', body)).json();
    expect(again.id).toBe(saved.id);
    expect(await (await request('/api/bugs')).json()).toHaveLength(1);
  });
  it('queues a repair once and allows retry after the record advances', async () => {
    const bug = createBug({ project: 'demo', repo: dir, requester: '用户', raw: '反馈' });
    applyBugAction(bug.id, 1, { type: 'triage' }, '控制台');
    applyBugAction(bug.id, 2, { type: 'reproduce', result: 'reproduced', evidenceRefs: ['复现记录'] }, '控制台');
    const url = `/api/bugs/${bug.id}/actions`;
    const body = { expectedRevision: 3, requestId: 'repair-001', action: { type: 'start-fix' } };
    expect((await request(url, 'POST', body)).status).toBe(202);
    expect((await request('/api/bug-requests/repair-001')).status).toBe(200);
    applyBugAction(bug.id, 3, { type: 'update', owner: '负责人' }, '控制台');
    expect((await request(url, 'POST', body)).status).toBe(202);
    expect((await request(url, 'POST', { ...body, action: { type: 'investigate' } })).status).toBe(409);
  });
  it('records a missing repair version only for the current linked ticket with evidence', async () => {
    let bug = createBug({ project: 'demo', repo: dir, requester: '用户', raw: '反馈' });
    const act = (action: Parameters<typeof applyBugAction>[2]) => bug = applyBugAction(bug.id, bug.revision, action, 'system:test');
    act({ type: 'triage' });
    act({ type: 'reproduce', result: 'located', evidenceRefs: ['定位记录'] });
    act({ type: 'reserve-ticket', ticket: 'DEMO-001', token: 'repair-token' });
    const url = `/api/bugs/${bug.id}`;
    expect((await (await request(url)).json()).allowedActions).not.toContain('fix-ready');
    act({ type: 'link-ticket', ticket: 'DEMO-001', token: 'repair-token' });
    expect((await (await request(url)).json()).allowedActions).toContain('fix-ready');
    const body = { expectedRevision: bug.revision, requestId: 'fix-ready-001', action: { type: 'fix-ready', ticket: bug.ticket, fixVersion: 'commit-a', evidenceRefs: ['工单完成，回归检查通过'] } };
    expect((await request(url + '/actions', 'POST', { ...body, action: { ...body.action, evidenceRefs: [] } })).status).toBe(400);
    expect((await request(url + '/actions', 'POST', { ...body, action: { ...body.action, ticket: 'DEMO-999' } })).status).toBe(400);
    expect((await request(url + '/actions', 'POST', { ...body, expectedRevision: 1 })).status).toBe(409);
    act({ type: 'need-info', reason: '请补充回归范围' });
    expect((await (await request(url)).json()).allowedActions).not.toContain('fix-ready');
    expect((await request(url + '/actions', 'POST', { ...body, expectedRevision: bug.revision })).status).toBe(400);
    act({ type: 'supplement', raw: '已覆盖原故障与相邻功能' });
    const finalBody = { ...body, expectedRevision: bug.revision };
    const result = await request(url + '/actions', 'POST', finalBody);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: '待上线', fixVersion: 'commit-a', ticket: 'DEMO-001' });
    expect((await request(url + '/actions', 'POST', finalBody)).status).toBe(200);
  });
});
