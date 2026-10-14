import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProcessEvidence } from '../src/engine/process.js';

/** Evidence is opt-in, fixture-owned, and strips configured credential values. */
export function acceptanceTrace(output: string, changed: () => void) {
  const directory = path.join(output, 'processes'); fs.mkdirSync(directory, { recursive: true });
  const secrets = new Set<string>();
  const collect = (env: Record<string, unknown>) => { for (const [name, value] of Object.entries(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)(?:$|_)/i.test(name) && typeof value === 'string' && value) secrets.add(value); };
  collect(process.env);
  const settings = path.join(os.homedir(), '.claude/settings.json');
  if (fs.existsSync(settings)) collect(JSON.parse(fs.readFileSync(settings, 'utf8')).env || {});
  const scrub = (text: string) => {
    for (const secret of secrets) for (const value of [secret, JSON.stringify(secret).slice(1, -1)]) text = text.split(value).join('[REDACTED_CREDENTIAL]');
    return text;
  };
  const walk = (value: unknown): unknown => typeof value === 'string' ? scrub(value) : Array.isArray(value) ? value.map(walk)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)])) : value;
  const scrubPayload = (text: string): string => {
    try { return JSON.stringify(walk(JSON.parse(text))); } catch { /* stream JSON or diagnostic lines */ }
    return text.split('\n').map(line => { try { return JSON.stringify(walk(JSON.parse(line))); } catch { return scrub(line); } }).join('\n');
  };
  const calls: { file: string; cwd: string; code: number | null; failure?: string }[] = [];
  const errors: string[] = [];
  const capture = (evidence: ProcessEvidence) => {
    const file = `${String(calls.length + 1).padStart(3, '0')}.json`;
    try {
      fs.writeFileSync(path.join(directory, file), JSON.stringify({ ...evidence, stdout: scrubPayload(evidence.stdout), stderr: scrubPayload(evidence.stderr), ...(evidence.failure ? { failure: scrub(evidence.failure) } : {}) }, null, 2), { encoding: 'utf8', mode: 0o600 });
      calls.push({ file: `processes/${file}`, cwd: evidence.cwd, code: evidence.code, ...(evidence.failure ? { failure: evidence.failure } : {}) }); changed();
    } catch (error) { errors.push((error as Error).message); }
  };
  return { capture, calls, errors };
}
