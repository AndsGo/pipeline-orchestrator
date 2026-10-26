import { parse, type ParseError } from 'jsonc-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const nativeModelEnvironment = (key: string, cli?: string): boolean => cli === 'claude'
  && ['ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL'].includes(key);

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, sorted(v)]));
  return value;
};
/** Exclude only documented parent defaults; roles and security settings stay bound. */
export function nativeJsonContext(text: string, cli: 'claude' | 'opencode', directory = process.cwd()): string {
  if (cli === 'opencode') {
    // Match native substitution order, including escaped file contents. Hash
    // the resulting retained values, not references removed with a default.
    const expanded = text.replace(/\{env:([^}]+)\}/g, (_token, key: string) => process.env[key] || '');
    text = expanded.replace(/\{file:([^}]+)\}/g, (token, reference: string, offset: number) => {
      if (expanded.slice(expanded.lastIndexOf('\n', offset - 1) + 1, offset).trimStart().startsWith('//')) return token;
      const target = reference.startsWith('~/') ? path.join(os.homedir(), reference.slice(2)) : path.resolve(directory, reference);
      try { return JSON.stringify(fs.readFileSync(target, 'utf8').trim()).slice(1, -1); }
      catch { throw new Error('执行配置检查失败：OpenCode 配置引用文件不可读'); }
    });
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: cli === 'opencode', disallowComments: cli === 'claude' });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('执行配置检查失败：原生 JSON 配置无法解析');
  if (typeof value.model === 'string') {
    if (cli === 'opencode' && value.model.includes('/')) value.model = value.model.slice(0, value.model.indexOf('/')) + '/@cli-default';
    else delete value.model;
  }
  if (cli === 'claude') {
    delete value.effortLevel;
    if (value.env && typeof value.env === 'object' && !Array.isArray(value.env)) {
      for (const key of Object.keys(value.env)) if (nativeModelEnvironment(key, cli)) delete value.env[key];
      if (!Object.keys(value.env).length) delete value.env;
    }
  }
  return JSON.stringify(sorted(value));
}

/** Only protocol metadata is evidence of a selected model; never infer from prose. */
export function observedNativeModel(cli: string, stdout = ''): string | undefined {
  if (cli !== 'claude') return undefined;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init' && !event.parent_tool_use_id && typeof event.model === 'string' && event.model.trim() && !/[\r\n\0]/.test(event.model)) return event.model;
    } catch { /* Non-protocol output is not model evidence. */ }
  }
  return undefined;
}
