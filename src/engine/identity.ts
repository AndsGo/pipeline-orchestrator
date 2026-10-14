import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.js';
import { codexCommand, codexEnvironment } from './codex.js';
import type { AgentProfile } from './configuration.js';
import { codexConfigurationContext } from './codexContext.js';

export const executionAccount = (): string => `${os.hostname()}/${os.userInfo().username}`;
export function credentialContext(ref?: string, cli?: AgentProfile['cli'], cwd?: string, diagnostics?: Record<string, string>): string {
  const environment = cli === 'codex' ? codexEnvironment() : process.env;
  if (ref && !environment[ref]) throw new Error(`凭据环境变量不可用：${ref}`);
  const hash = createHash('sha256');
  const sources: { text: string; directory: string; opencode: boolean }[] = [];
  const observe = (label: string, content: string | Buffer) => { if (diagnostics) diagnostics[label] = createHash('sha256').update(content).digest('hex'); };
  const fileSource = (file: string, codexGlobal = false): void => {
    const content = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('absent');
    let effective: string | Buffer = content;
    if (codexGlobal && fs.existsSync(file)) {
      try { effective = codexConfigurationContext(content.toString('utf8'), cwd); }
      catch { throw new Error(`Codex 配置 TOML 无法解析：${file}`); }
      // Diagnostic byte hashes do not authorize or invalidate semantic identity.
      observe(`raw-file:${file}`, content);
    }
    observe(`file:${file}`, effective);
    hash.update(file).update(effective); sources.push({ text: content.toString('utf8'), directory: path.dirname(file), opencode: /opencode(?:\.jsonc?|[/\\]auth\.json)$/i.test(file) });
  };
  const prefixes = cli === 'claude' ? /^(ANTHROPIC_|CLAUDE_|HOME$|USERPROFILE$)/
    : cli === 'codex' ? /^(OPENAI_|CODEX_HOME$|CODEX_API_KEY$|HOME$|USERPROFILE$)/
    : cli === 'opencode' ? /^(ANTHROPIC_|OPENAI_|OPENCODE_|XDG_|HOME$|USERPROFILE$)/
    : /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENCODE_|XDG_|HOME$|USERPROFILE$)/;
  const keys = Object.keys(environment).filter(k => prefixes.test(k) || k === ref).sort();
  for (const key of keys) { const value = JSON.stringify([key, environment[key]]); observe(`env:${key}`, value); hash.update(value); }
  const home = os.homedir();
  const codexHome = environment.CODEX_HOME || path.join(home, '.codex');
  const files = [
    ...(!cli || cli === 'claude' ? [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json'), path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json')] : []),
    ...(!cli || cli === 'codex' ? [path.join(codexHome, 'auth.json'), path.join(codexHome, 'config.toml')] : []),
    ...(!cli || cli === 'opencode' ? [path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/auth.json'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode/opencode.json'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode/opencode.jsonc')] : []),
  ];
  for (const file of files) fileSource(file, file === path.join(codexHome, 'config.toml'));
  if ((!cli || cli === 'opencode') && process.env.OPENCODE_CONFIG_CONTENT) sources.push({ text: process.env.OPENCODE_CONFIG_CONTENT, directory: cwd || process.cwd(), opencode: true });
  const externalConfig = process.env.OPENCODE_CONFIG;
  if ((!cli || cli === 'opencode') && externalConfig) {
    const file = path.resolve(cwd || process.cwd(), externalConfig);
    fileSource(file);
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
    for (const key of ['oauthAccount', 'primaryApiKey', 'apiKeyHelper', 'env', 'model']) hash.update(JSON.stringify([key, state[key]]));
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
  if (!v || v.account !== executionAccount() || v.command !== commandIdentity(profile.cli) || v.credentialContext !== credentialContext(profile.credentialRef, profile.cli) || v.cliVersion !== await cliVersion(profile.cli)) throw new Error('CLI 路径、版本或运行账号／凭据上下文已变化，请重新验证执行配置');
  if (cwd && (!frozenContext || frozenContext !== credentialContext(undefined, profile.cli, cwd))) throw new Error('项目原生配置与执行快照不一致，请重新验证并显式切换执行配置');
}
