import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.js';
import { codexCommand, codexEnvironment } from './codex.js';
import type { AgentProfile } from './configuration.js';
import { codexConfigurationContext } from './codexContext.js';
import { nativeJsonContext, nativeModelEnvironment } from './nativeDefaults.js';

export const executionAccount = (): string => `${os.hostname()}/${os.userInfo().username}`;
export type IdentityPolicy = 'codex-native-v2' | 'cli-defaults-v1';
export function credentialContext(ref?: string, cli?: AgentProfile['cli'], cwd?: string, diagnostics?: Record<string, string>, policy?: IdentityPolicy): string {
  const environment = cli === 'codex' ? codexEnvironment() : process.env;
  const followsCli = policy === 'cli-defaults-v1';
  if (ref && !environment[ref]) throw new Error(`凭据环境变量不可用：${ref}`);
  const hash = createHash('sha256');
  if (policy) hash.update(policy);
  const sources: { text: string; directory: string; opencode: boolean }[] = [];
  const observe = (label: string, content: string | Buffer) => { if (diagnostics) diagnostics[label] = createHash('sha256').update(content).digest('hex'); };
  const fileSource = (file: string, codexGlobal = false, externalConfig = false): void => {
    const content = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('absent');
    let effective: string | Buffer = content;
    if (codexGlobal && fs.existsSync(file)) {
      try { effective = codexConfigurationContext(content.toString('utf8'), cwd, policy === 'codex-native-v2' || followsCli); }
      catch { throw new Error(`Codex 配置 TOML 无法解析：${file}`); }
      // Diagnostic byte hashes do not authorize or invalidate semantic identity.
      observe(`raw-file:${file}`, content);
    }
    if (followsCli && fs.existsSync(file) && ((cli === 'claude' && /settings(?:\.local)?\.json$/.test(file)) || (cli === 'opencode' && (externalConfig || /opencode\.jsonc?$/.test(file))))) {
      observe(`raw-file:${file}`, content);
      effective = nativeJsonContext(content.toString('utf8'), cli as 'claude' | 'opencode', path.dirname(file));
    }
    observe(`file:${file}`, effective);
    hash.update(file).update(effective); sources.push({ text: (followsCli ? effective : content).toString(), directory: path.dirname(file), opencode: externalConfig || /opencode(?:\.jsonc?|[/\\]auth\.json)$/i.test(file) });
  };
  const prefixes = cli === 'claude' ? /^(ANTHROPIC_|CLAUDE_|HOME$|USERPROFILE$)/
    : cli === 'codex' ? /^(OPENAI_|CODEX_HOME$|CODEX_API_KEY$|HOME$|USERPROFILE$)/
    : cli === 'opencode' ? /^(ANTHROPIC_|OPENAI_|OPENCODE_|XDG_|HOME$|USERPROFILE$)/
    : /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENCODE_|XDG_|HOME$|USERPROFILE$)/;
  const keys = Object.keys(environment).filter(k => (prefixes.test(k) || k === ref) && !(followsCli && nativeModelEnvironment(k, cli))).sort();
  for (const key of keys) { const content = followsCli && cli === 'opencode' && key === 'OPENCODE_CONFIG_CONTENT' && environment[key] ? nativeJsonContext(environment[key]!, 'opencode', cwd || process.cwd()) : environment[key]; const value = JSON.stringify([key, content]); observe(`env:${key}`, value); hash.update(value); }
  const home = os.homedir();
  const codexHome = environment.CODEX_HOME || path.join(home, '.codex');
  const files = [
    ...(!cli || cli === 'claude' ? [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json'), path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json')] : []),
    ...(!cli || cli === 'codex' ? [path.join(codexHome, 'auth.json'), path.join(codexHome, 'config.toml')] : []),
    ...(!cli || cli === 'opencode' ? [path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/auth.json'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode/opencode.json'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode/opencode.jsonc')] : []),
  ];
  for (const file of files) fileSource(file, file === path.join(codexHome, 'config.toml'));
  if ((!cli || cli === 'opencode') && process.env.OPENCODE_CONFIG_CONTENT) sources.push({ text: followsCli ? nativeJsonContext(process.env.OPENCODE_CONFIG_CONTENT, 'opencode', cwd || process.cwd()) : process.env.OPENCODE_CONFIG_CONTENT, directory: cwd || process.cwd(), opencode: true });
  const externalConfig = process.env.OPENCODE_CONFIG;
  if ((!cli || cli === 'opencode') && externalConfig) {
    const file = path.resolve(cwd || process.cwd(), externalConfig);
    fileSource(file, false, true);
    sources.at(-1)!.opencode = true;
  }
  if ((!cli || cli === 'opencode') && process.env.OPENCODE_CONFIG_DIR) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const file = path.resolve(process.env.OPENCODE_CONFIG_DIR, name);
      fileSource(file);
    }
  }
  if (cwd) {
    const roots: string[] = [];
    let directory = fs.realpathSync.native(cwd);
    while (true) { roots.unshift(directory); const parent = path.dirname(directory); if (parent === directory) break; directory = parent; }
    const names = !cli ? ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', 'opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
      : cli === 'opencode' ? ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
      : cli === 'codex' ? ['.codex/config.toml'] : ['.claude/settings.json', '.claude/settings.local.json'];
    // Hash existing ancestor sources in precedence order; an added or removed file
    // changes the digest, while two isolated projects with no config remain equal.
    for (const directory of roots) for (const name of names) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) fileSource(file);
    }
  }
  // Native providers may reference arbitrary environment names, not only the
  // built-in OPENAI_/ANTHROPIC_ prefixes. Hash their values without exposing them.
  const references = new Set<string>();
  for (const source of sources) {
    const { text } = source;
    for (const match of text.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) references.add(match[1]);
    for (const match of text.matchAll(/env_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) references.add(match[1]);
    for (const match of text.matchAll(/["']env["']\s*:\s*\[([^\]]*)\]/g))
      for (const name of match[1].matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) references.add(name[1]);
    if (source.opencode && (!cli || cli === 'opencode')) {
      // Match native substitution order: environment values can expand to a
      // file reference. File contents are inserted literally, not recursively.
      const expanded = text.replace(/\{env:([^}]+)\}/g, (_token, name: string) => process.env[name] || '');
      for (const match of expanded.matchAll(/\{file:([^}]+)\}/g)) {
        const prefix = expanded.slice(expanded.lastIndexOf('\n', match.index! - 1) + 1, match.index).trimStart();
        if (prefix.startsWith('//')) continue;
        // Native substitution scans the raw text before JSON parsing.
        const reference = match[1];
        const expandedPath = reference.startsWith('~/') ? path.join(os.homedir(), reference.slice(2)) : reference;
        const target = path.resolve(source.directory, expandedPath);
        const content = fs.existsSync(target) ? fs.readFileSync(target) : 'absent'; observe(`file:${target}`, content);
        hash.update(target).update(content);
      }
    }
  }
  for (const key of [...references].sort()) { const value = JSON.stringify([key, environment[key] ?? null]); observe(`env:${key}`, value); hash.update(value); }
  const claudeState = path.join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  if ((!cli || cli === 'claude') && fs.existsSync(claudeState)) {
    const state = JSON.parse(fs.readFileSync(claudeState, 'utf8')) as Record<string, unknown>;
    observe(`state:${claudeState}`, JSON.stringify(['oauthAccount', 'primaryApiKey', 'apiKeyHelper', 'env', 'model'].map(key => [key, state[key]])));
    for (const key of ['oauthAccount', 'primaryApiKey', 'apiKeyHelper', 'env', 'model']) {
      if (followsCli && key === 'model') continue;
      const value = followsCli && key === 'env' && state[key] && typeof state[key] === 'object' ? Object.fromEntries(Object.entries(state[key] as object).filter(([name]) => !nativeModelEnvironment(name, 'claude'))) : state[key];
      hash.update(JSON.stringify([key, value]));
    }
  }
  return hash.digest('hex');
}
export function commandIdentity(cli: AgentProfile['cli']): string {
  if (cli === 'claude') {
    const r = spawnSync('bash', ['-c', 'command -v claude'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status !== 0) throw new Error('Claude Code 不可用');
    return r.stdout.trim();
  }
  const command = cli === 'codex' ? codexCommand() : { cmd: process.env.PIPELINE_OPENCODE_BIN || 'opencode', prefix: [] };
  const resolved = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command.cmd], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const executable = path.isAbsolute(command.cmd) ? command.cmd : resolved.status === 0 ? resolved.stdout.trim().split(/\r?\n/)[0] : '';
  if (!executable || !fs.existsSync(executable)) throw new Error(`${cli} 可执行文件不可用`);
  return JSON.stringify({ cmd: fs.realpathSync(executable), prefix: command.prefix.map(p => fs.existsSync(p) ? fs.realpathSync(p) : p) });
}
export async function cliVersion(cli: AgentProfile['cli']): Promise<string> {
  if (cli === 'claude') {
    const r = spawnSync('bash', ['-c', 'claude --version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status !== 0) throw new Error('Claude Code 不可用');
    return r.stdout.trim();
  }
  const command = cli === 'codex' ? codexCommand() : { cmd: process.env.PIPELINE_OPENCODE_BIN || 'opencode', prefix: [] };
  const r = await runProcess(command.cmd, [...command.prefix, '--version'], { cwd: process.cwd(), timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`${cli} 不可用`);
  return r.stdout.trim();
}
export async function assertRuntimeIdentity(profile: AgentProfile, cwd?: string, frozenContext?: string): Promise<void> {
  if (profile.state !== 'active') return; // Legacy means explicitly unprobed, displayed as such.
  const v = profile.validation;
  const fail = (reason: string): never => { throw new Error(`执行配置检查失败：${reason}，请重新验证执行配置；重发或改用 /run 无法解除此检查`); };
  if (!v) return fail('缺少验证记录');
  if (v.account !== executionAccount()) fail('运行账号已变化');
  if (v.command !== commandIdentity(profile.cli)) fail('CLI 可执行路径已变化');
  if (v.credentialContext !== profileCredentialContext(profile)) fail('凭据、供应商或原生配置已变化');
  if (v.cliVersion !== await cliVersion(profile.cli)) fail('CLI 版本已变化');
  if (cwd && (!frozenContext || frozenContext !== profileCredentialContext(profile, cwd))) fail('项目原生配置与执行快照不一致，需显式切换执行配置');
}

/** Old validation records keep their old policy until a real probe succeeds. */
export function profileCredentialContext(profile: AgentProfile, cwd?: string, diagnostics?: Record<string, string>, policy = profile.validation?.identityPolicy): string {
  if (policy && ((profile.constraintMode ?? 'native') !== 'native' || (policy === 'codex-native-v2' ? profile.cli !== 'codex' : policy !== 'cli-defaults-v1' || profile.modelSource !== 'cli'))) throw new Error('执行配置检查失败：不兼容的身份校验策略');
  return credentialContext(cwd ? undefined : profile.credentialRef, profile.cli, cwd, diagnostics, policy);
}
