import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assertRuntimeIdentity, commandIdentity, executionAccount, profileCredentialContext } from '../engine/identity.js';
import { freezeExecution, type AgentProfile } from '../engine/configuration.js';
import * as subprocess from '../engine/process.js';

let root: string;
let file: string;
const env = { ...process.env };
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-native-policy-')));
  file = path.join(root, 'config.toml');
  process.env.PIPELINE_CODEX_HOME = root;
  process.env.PIPELINE_CODEX_BIN = process.execPath;
  fs.writeFileSync(file, 'model="old-default"\nmodel_reasoning_effort="low"\n');
  vi.spyOn(subprocess, 'runProcess').mockResolvedValue({ code: 0, stdout: 'test-version', stderr: '' });
});
afterEach(() => { vi.restoreAllMocks(); process.env = { ...env }; fs.rmSync(root, { recursive: true, force: true }); });
function profile(modern = true): AgentProfile {
  const p: AgentProfile = { id: 'test', name: 'test', cli: 'codex', state: 'active', constraintMode: 'native', model: 'fixed-model', parameters: {}, validation: {
    fingerprint: '', at: 'test', entries: ['run'], checks: [], cliVersion: 'test-version', account: executionAccount(), command: commandIdentity('codex'),
    identityPolicy: modern ? 'codex-native-v2' : undefined,
  } };
  p.validation!.credentialContext = profileCredentialContext(p);
  return p;
}
it('allows changed global model/effort on a new and frozen native execution while keeping its explicit model', async () => {
  const p = profile(); const frozen = freezeExecution(undefined, 'run', p, root);
  fs.writeFileSync(file, 'model="new-default"\nmodel_reasoning_effort="high"\n');
  await expect(assertRuntimeIdentity(frozen.profile, root, frozen.nativeContext)).resolves.toBeUndefined();
  const next = freezeExecution(undefined, 'run', p, root);
  expect(next.nativeContext).toBe(frozen.nativeContext);
  expect(next.model).toBe('fixed-model');
});
it('keeps old validation and old snapshots strict until real revalidation', async () => {
  const p = profile(false); const frozen = freezeExecution(undefined, 'run', p, root);
  fs.writeFileSync(file, 'model="new-default"\nmodel_reasoning_effort="high"\n');
  await expect(assertRuntimeIdentity(frozen.profile, root, frozen.nativeContext)).rejects.toThrow('执行配置检查失败');
  p.validation!.identityPolicy = 'codex-native-v2';
  await expect(assertRuntimeIdentity(p)).rejects.toThrow('执行配置检查失败');
});
it.each([
  'sandbox_mode="danger-full-access"',
  'approval_policy="never"',
  'model_provider="different"',
  '[model_providers.local]\nbase_url="https://different.example"',
  '[agents.reviewer]\nmodel="different-child-model"',
  '[profiles.selected]\nmodel="different-profile-model"',
  'unknown_setting=true',
])('still rejects sensitive, role and unknown configuration changes: %s', async extra => {
  const p = profile(); fs.appendFileSync(file, extra + '\n');
  await expect(assertRuntimeIdentity(p)).rejects.toThrow('执行配置检查失败');
});
it('still rejects changed credentials and project configuration', async () => {
  const p = profile(); const frozen = freezeExecution(undefined, 'run', p, root);
  fs.writeFileSync(path.join(root, 'auth.json'), '{"token":"fixture"}');
  await expect(assertRuntimeIdentity(p)).rejects.toThrow('凭据');
  fs.unlinkSync(path.join(root, 'auth.json'));
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex/config.toml'), 'model_provider="changed"');
  await expect(assertRuntimeIdentity(p, root, frozen.nativeContext)).rejects.toThrow('项目原生配置');
});
it('does not allow the native policy on strict profiles or other engines', () => {
  const p = profile(); p.constraintMode = 'strict';
  expect(() => profileCredentialContext(p)).toThrow('不兼容');
  p.constraintMode = 'native'; p.cli = 'opencode';
  expect(() => profileCredentialContext(p)).toThrow('不兼容');
});
