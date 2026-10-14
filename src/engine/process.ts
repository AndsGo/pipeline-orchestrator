import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { beginInvocation } from './invocations.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProcessEvidence { command: string; cwd: string; stdout: string; stderr: string; code: number | null; failure?: string; }
const evidence = new AsyncLocalStorage<(result: ProcessEvidence) => void>();
/** Explicitly scoped diagnostics; never records argv, stdin or credentials. */
export const withProcessEvidence = <T>(capture: (result: ProcessEvidence) => void, fn: () => T): T => evidence.run(capture, fn);

export function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
export interface ProcessResult { stdout: string; stderr: string; code: number; }
/** argv only, bounded output, bounded execution, and cleanup of descendants. */
export function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; stdin?: string }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const invocation = beginInvocation(command, options.cwd);
    let child: ChildProcess;
    try { child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { invocation?.closed(); reject(e); return; }
    let stdout = '', stderr = '', failure: Error | undefined;
    try { if (child.pid) invocation?.spawned(child.pid); }
    catch (e) { failure = e as Error; stopProcessTree(child); }
    const finish = (error: Error): void => { failure = error; stopProcessTree(child); };
    const timer = setTimeout(() => finish(new Error(`CLI 执行超时（${options.timeoutMs}ms）`)), options.timeoutMs);
    child.stdout!.on('data', (buffer: Buffer) => { stdout += buffer.toString('utf8'); if (stdout.length > 16_000_000) finish(new Error('CLI 输出超过 16MB')); });
    child.stderr!.on('data', (buffer: Buffer) => { stderr = (stderr + buffer.toString('utf8')).slice(-100_000); });
    child.on('error', (e) => { failure = e; clearTimeout(timer); invocation?.closed(); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer); invocation?.closed();
      // Observability must not change the native process outcome. The diagnostic
      // caller reports its own persistence failure separately.
      try { evidence.getStore()?.({ command, cwd: options.cwd, stdout, stderr, code, ...(failure ? { failure: failure.message } : {}) }); } catch { /* diagnostic callback failure */ }
      if (failure) reject(failure); else resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.stdin);
  });
}
