import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';

const normalized = (value: string): string => {
  let resolved = value;
  try { resolved = fs.realpathSync.native(value); } catch { /* Missing entries cannot alias an existing cwd. */ }
  resolved = resolved.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  resolved = path.normalize(resolved);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
export function codexProjectRoots(cwd: string): { roots: string[]; uncertain: boolean } {
  const roots: string[] = [];
  let directory = fs.realpathSync.native(cwd), hasGit = false;
  while (true) {
    roots.push(normalized(directory)); hasGit ||= fs.existsSync(path.join(directory, '.git'));
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  let uncertain = hasGit && git.status !== 0;
  if (git.status === 0) {
    const common = git.stdout.trim();
    if (path.basename(common) === '.git') roots.push(normalized(path.dirname(common)));
    else uncertain = true; // Unusual bare/separate-git-dir layout: retain all trust entries.
  }
  return { roots: [...new Set(roots)], uncertain };
}
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
};
/** Pure trust registrations for other projects do not change this execution.
 * Unknown fields and uncertain paths remain bound; no raw-text filtering. */
export function codexConfigurationContext(text: string, cwd?: string): string {
  const config = parse(text, { integersAsBigInt: true });
  const projects = config.projects;
  if (projects && typeof projects === 'object' && !Array.isArray(projects) && !(projects instanceof Date)) {
    const context = cwd ? codexProjectRoots(cwd) : undefined;
    const retained = Object.entries(projects).filter(([key, value]) => {
      const pureTrust = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
        && 'trust_level' in value && ['trusted', 'untrusted'].includes(String(value.trust_level));
      if (!pureTrust || !path.isAbsolute(key)) return true;
      return !!context && (context.uncertain || context.roots.includes(normalized(key)));
    });
    if (retained.length) config.projects = Object.fromEntries(retained);
    else delete config.projects;
  }
  return stringify(sorted(config) as Parameters<typeof stringify>[0], { numbersAsFloat: true });
}
