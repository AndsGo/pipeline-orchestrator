import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexConfigurationContext } from '../engine/codexContext.js';
import { credentialContext } from '../engine/identity.js';
import { codexEnvironment } from '../engine/codex.js';

let root: string;
const env = { ...process.env };
beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-codex-context-'))); });
afterEach(() => { process.env = { ...env }; fs.rmSync(root, { recursive: true, force: true }); });
const trust = (directory: string, value = 'trusted', extra = '') => `\n[projects.${JSON.stringify(directory)}]\ntrust_level = ${JSON.stringify(value)}\n${extra}`;
describe('Codex native configuration identity', () => {
  it('binds the actual CLI environment and the configured native home across host sessions', () => {
    const native = path.join(root, 'native'); fs.mkdirSync(native); fs.writeFileSync(path.join(native, 'config.toml'), 'model="test"');
    process.env.PIPELINE_CODEX_HOME = native; process.env.CODEX_HOME = path.join(root, 'host');
    process.env.CODEX_SESSION_ID = 'host-a'; process.env.CODEX_THREAD_ID = 'host-thread-a';
    const before = credentialContext(undefined, 'codex');
    process.env.CODEX_SESSION_ID = 'host-b'; process.env.CODEX_THREAD_ID = 'host-thread-b'; process.env.CODEX_CI = 'host-c';
    expect(credentialContext(undefined, 'codex')).toBe(before);
    const actual = codexEnvironment(); expect(actual.CODEX_HOME).toBe(native);
    expect(actual.CODEX_SESSION_ID).toBeUndefined(); expect(actual.CODEX_THREAD_ID).toBeUndefined();
    fs.writeFileSync(path.join(native, 'config.toml'), '[model_providers.test]\nenv_key="CODEX_CI"');
    const explicit = credentialContext(undefined, 'codex'); process.env.CODEX_CI = 'another-provider-key';
    expect(credentialContext(undefined, 'codex')).not.toBe(explicit);
  });
  it('ignores presentation and unrelated pure trust registrations while retaining the current project missing/present state', () => {
    const base = 'model = "test-model"\n';
    const other = path.join(os.tmpdir(), 'unrelated-native-project');
    expect(codexConfigurationContext(base + trust(other))).toBe(codexConfigurationContext(base));
    expect(codexConfigurationContext(base + trust(other), root)).toBe(codexConfigurationContext(base, root));
    expect(codexConfigurationContext(base + trust(root), root)).not.toBe(codexConfigurationContext(base, root));
    expect(codexConfigurationContext('# comment\nmodel="test-model"\n')).toBe(codexConfigurationContext(base));
    expect(codexConfigurationContext(base + trust(root, 'untrusted'), root)).not.toBe(codexConfigurationContext(base + trust(root), root));
  });
  it('retains providers, unknown project fields, invalid trust values and unresolved relative entries', () => {
    const base = 'model = "test-model"\n';
    for (const extra of ['[model_providers.local]\nbase_url="https://provider.example"', trust(path.join(root, 'other'), 'trusted', 'unknown_setting = true'), trust(path.join(root, 'other'), 'other-value'), trust('relative-project')]) {
      expect(codexConfigurationContext(base + extra)).not.toBe(codexConfigurationContext(base));
    }
    expect(codexConfigurationContext('unknown=1.0\n')).not.toBe(codexConfigurationContext('unknown=1\n'));
  });
  it('binds Windows case aliases and a linked worktree main repository trust', () => {
    if (process.platform === 'win32') expect(codexConfigurationContext(trust(root.toUpperCase()), root)).not.toBe(codexConfigurationContext('', root));
    const repo = path.join(root, 'main'), worktree = path.join(root, 'linked'); fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
    git('init', '-q'); git('-c', 'user.name=Context test', '-c', 'user.email=context@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Context fixture');
    git('worktree', 'add', '-qb', 'linked-test', worktree);
    expect(codexConfigurationContext(trust(repo, 'trusted'), worktree)).not.toBe(codexConfigurationContext(trust(repo, 'untrusted'), worktree));
  });
  it('keeps raw diagnostics separate from effective identity and rejects malformed TOML without echoing secrets', () => {
    const native = path.join(root, 'native'); fs.mkdirSync(native); process.env.CODEX_HOME = native;
    const file = path.join(native, 'config.toml'); fs.writeFileSync(file, 'model="test"');
    const before: Record<string, string> = {}, after: Record<string, string> = {};
    const baseline = credentialContext(undefined, 'codex', undefined, before);
    fs.appendFileSync(file, trust(path.join(root, 'other')));
    expect(credentialContext(undefined, 'codex', undefined, after)).toBe(baseline);
    expect(after[`raw-file:${file}`]).not.toBe(before[`raw-file:${file}`]);
    fs.writeFileSync(file, 'api_key = "never-print-this-secret');
    expect(() => credentialContext(undefined, 'codex')).toThrow('TOML 无法解析');
    try { credentialContext(undefined, 'codex'); } catch (error) { expect(String(error)).not.toContain('never-print-this-secret'); }
  });
});
