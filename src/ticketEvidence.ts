import { execFileSync } from 'node:child_process';

/** Freeze the actual checkout at completion; never infer it from a moving ref on recovery. */
export function ticketCompletionEvidence(repo: string): Record<string, unknown> {
  try {
    const fixVersion = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40,64}$/i.test(fixVersion) ? { fixVersion } : {};
  } catch { return {}; }
}
