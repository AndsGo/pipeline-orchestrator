import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebServer, mountRoutes } from '../web/server.js';
import { createOutputRecord } from '../output/records.js';
import { resolveOutput } from '../output/configuration.js';

let dir: string, base: string, cookie: string;
let server: ReturnType<typeof createWebServer>;
const environment = { ...process.env };
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-route-'));
  process.env.PIPELINE_DATA_DIR = dir;
  server = createWebServer(mountRoutes({ CONSOLE_TOKEN: 'output-test-token' }, () => {}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'output-test-token' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  process.env = { ...environment };
  fs.rmSync(dir, { recursive: true, force: true });
});
const request = (url: string, method = 'GET', body?: unknown) => fetch(`${base}${url}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('output console API', () => {
  it('requires authentication for settings and records', async () => {
    for (const url of ['/api/output-settings', '/api/outputs', '/api/outputs/00000000-0000-0000-0000-000000000000'])
      expect((await fetch(base + url)).status).toBe(401);
  });
  it('saves settings with immediate resolution and rejects stale and invalid writes', async () => {
    const configuration = await (await request('/api/output-settings')).json();
    expect(configuration.defaultLevel).toBe('concise');
    configuration.projects[dir] = { defaultLevel: 'professional', stages: { delivery: 'concise' } };
    expect((await request('/api/output-settings', 'PUT', { revision: 0, configuration })).status).toBe(200);
    expect(resolveOutput(dir, 'answer').level).toBe('professional');
    expect(resolveOutput(dir, 'delivery').level).toBe('concise');
    expect((await request('/api/output-settings', 'PUT', { revision: 0, configuration })).status).toBe(409);
    configuration.defaultLevel = 'invalid';
    expect((await request('/api/output-settings', 'PUT', { revision: 1, configuration })).status).toBe(400);
    expect((await request('/api/output-settings', 'PUT', {})).status).toBe(400);
  });
  it('returns records and distinguishes invalid and missing identifiers', async () => {
    const record = createOutputRecord({ stage: 'delivery', title: '完成', summary: '已完成', detail: '详细内容', risks: ['风险'], actions: ['待办'], evidence: [] });
    expect(await (await request('/api/outputs')).json()).toMatchObject([{ id: record.id }]);
    expect(await (await request('/api/outputs/' + record.id)).json()).toMatchObject({ id: record.id, risks: ['风险'] });
    expect((await request('/api/outputs/not-an-id')).status).toBe(400);
    expect((await request('/api/outputs/%2e%2e%2fsecret')).status).toBe(400);
    expect((await request('/api/outputs/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
  it('uses the same resolved project key after saving and reading again', async () => {
    const view = await (await request('/api/projects')).json();
    for (const project of view.projects) expect(project.outputRepo).toBe(path.resolve(project.repo));
    const configuration = await (await request('/api/output-settings')).json();
    const inputRepo = process.platform === 'win32' ? dir.replaceAll('\\', '/') : dir;
    configuration.projects[inputRepo] = { defaultLevel: 'professional' };
    const first = await (await request('/api/output-settings', 'PUT', { revision: 0, configuration })).json();
    const canonical = path.resolve(inputRepo);
    expect(first.projects[canonical].defaultLevel).toBe('professional');
    const reread = await (await request('/api/output-settings')).json();
    reread.projects[canonical].stages = { delivery: 'concise' };
    const second = await (await request('/api/output-settings', 'PUT', { revision: 1, configuration: reread })).json();
    expect(Object.keys(second.projects)).toEqual([canonical]);
    expect(second.projects[canonical]).toEqual({ defaultLevel: 'professional', stages: { delivery: 'concise' } });
  });
});
