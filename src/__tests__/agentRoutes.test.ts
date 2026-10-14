import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebServer, mountRoutes } from '../web/server.js';
import { initialConfiguration, readConfiguration, selectProfile } from '../engine/configuration.js';

let root: string, base: string, cookie: string;
let server: ReturnType<typeof createWebServer>;
const environment = { ...process.env };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-route-'));
  process.env.PIPELINE_DATA_DIR = root;
  delete process.env.PIPELINE_AGENT_CONFIG_FILE;
  server = createWebServer(mountRoutes({ CONSOLE_TOKEN: 'agent-test-token' }, () => {}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'agent-test-token' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); process.env = { ...environment }; fs.rmSync(root, { recursive: true, force: true }); });
const request = (url: string, method = 'GET', body?: unknown) => fetch(`${base}${url}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('execution configuration HTTP flow', () => {
  it('requires confirmation of the exact server probe plan before any billable validation', async () => {
    const plan = await (await request('/api/agents/legacy-claude/validation-plan', 'POST', { revision: 0, entries: ['run', 'implement'] })).json();
    expect(plan.calls).toBe(13);
    expect(plan.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await request('/api/agents/legacy-claude/validate', 'POST', { revision: 0, entries: ['run', 'implement'], confirmCost: true, planToken: 'stale' })).status).toBe(409);
    expect(readConfiguration().revision).toBe(0);
  });
  it('requires console authentication and exposes CLI capability blockers', async () => {
    expect((await fetch(`${base}/api/agents`)).status).toBe(401);
    const view = await (await request('/api/agents')).json();
    expect(view.entries).toContain('classify'); expect(view.entries).toContain('mr-review');
    expect(view.capabilities.opencode.budget.supported).toBe(false);
    expect(view.capabilities.codex.permissions.supported).toBe(false);
  });
  it('browser scope is part of the acknowledged paid plan', async () => {
    const plan = await (await request('/api/agents/legacy-claude/validation-plan', 'POST', { revision: 0, entries: ['review'], browser: false })).json();
    expect(plan.contexts[0].browserProbe).toBe(false);
    expect((await request('/api/agents/legacy-claude/validate', 'POST', { revision: 0, entries: ['review'], browser: true, confirmCost: true, planToken: plan.token })).status).toBe(409);
    expect((await request('/api/agents/legacy-claude/validation-plan', 'POST', { revision: 0, entries: ['review'], browser: 'no' })).status).toBe(400);
  });
  it('cannot activate client-forged probe evidence; stale revisions cannot overwrite', async () => {
    const configuration = initialConfiguration();
    configuration.profiles.push({ id: 'custom', name: 'custom', cli: 'claude', model: 'sonnet', parameters: {}, state: 'active', validation: { fingerprint: 'forged', at: '', entries: ['run'], cliVersion: 'test', account: 'test', checks: [] } });
    const result = await request('/api/agents', 'PUT', { revision: 0, configuration });
    expect(result.status).toBe(200);
    expect(readConfiguration().profiles.at(-1)?.state).toBe('draft');
    expect(readConfiguration().profiles.at(-1)?.validation).toBeUndefined();
    expect((await request('/api/agents', 'PUT', { revision: 0, configuration })).status).toBe(400);
    expect(readConfiguration().revision).toBe(1);
  });
  it('a blocked real-probe request never activates OpenCode or changes defaults', async () => {
    const configuration = initialConfiguration();
    configuration.profiles.find(p => p.cli === 'opencode')!.provider = 'custom-provider';
    expect((await request('/api/agents', 'PUT', { revision: 0, configuration })).status).toBe(200);
    expect((await request('/api/agents/legacy-opencode/validate', 'POST', { revision: 1, entries: ['run'], confirmCost: false })).status).toBe(400);
    const response = await request('/api/agents/legacy-opencode/validate', 'POST', { revision: 1, entries: ['run'], confirmCost: true });
    const report = await response.json();
    expect(report.ok).toBe(false); expect(report.costUsd).toBe(0);
    expect(report.errors.join()).toContain('未冻结');
    expect(selectProfile(undefined, 'run').cli).toBe('codex');
  });
  it('rejects secret fields and invalid credential references instead of persisting them', async () => {
    const configuration = initialConfiguration();
    configuration.profiles.push({ id: 'bad', name: 'bad', cli: 'claude', parameters: {}, state: 'draft', credentialRef: 'not a variable' });
    expect((await request('/api/agents', 'PUT', { revision: 0, configuration })).status).toBe(400);
    expect(fs.existsSync(path.join(root, 'agent-config.json'))).toBe(false);
  });
});
