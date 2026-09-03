import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export type PidAlive = (pid: number) => boolean;

export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0：只探测存活
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = 存活但无权限
  }
}

function lockFile(ticket: string): string {
  return path.join(dataDir(), `${ticket}.lock`);
}

/**
 * 工单级锁：同一工单只允许一个编排器实例。
 * 持有者进程已死 → 视为陈旧锁，接管。
 */
export function acquireLock(ticket: string, pidAlive: PidAlive = defaultPidAlive): { ok: true } | { ok: false; holder: LockInfo } {
  fs.mkdirSync(dataDir(), { recursive: true });
  const f = lockFile(ticket);
  if (fs.existsSync(f)) {
    try {
      const holder = JSON.parse(fs.readFileSync(f, 'utf-8')) as LockInfo;
      if (holder.pid !== process.pid && pidAlive(holder.pid)) {
        return { ok: false, holder };
      }
    } catch {
      // 锁文件损坏 → 当陈旧处理
    }
  }
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockInfo), 'utf-8');
  return { ok: true };
}

export function releaseLock(ticket: string): void {
  const f = lockFile(ticket);
  try {
    const holder = JSON.parse(fs.readFileSync(f, 'utf-8')) as LockInfo;
    if (holder.pid === process.pid) fs.unlinkSync(f);
  } catch {
    /* 已不存在或非本进程持有：不动 */
  }
}

/**
 * 孤儿检测：查找仍在运行本工单 pipeline 阶段的 claude 进程
 * （编排器死亡后 claude 子树可能存活——LS-002 双控制器事故的根因）。
 */
export function findOrphanClaude(ticket: string): Array<{ pid: number; cmd: string }> {
  if (process.platform !== 'win32') {
    try {
      const out = execSync(`ps -eo pid,args | grep "pipeline-.* ${ticket}" | grep -v grep`, { encoding: 'utf-8' });
      return out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), cmd: l.trim() }));
    } catch {
      return [];
    }
  }
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match 'pipeline-.* ${ticket}' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine.Substring(0,[Math]::Min(120,$_.CommandLine.Length)))" }`;
    // 不走 cmd：以前 execSync 经 cmd 转发，cmd 不认 \" 转义、把内层 | 当管道，命令被劈成两半——
    // daemon.log 里那串「'$' 不是内部或外部命令」就是它，孤儿检测自 Windows 上线起一直是哑的（2026-09-02 查明）
    const out = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [pid, ...rest] = l.split('|');
        return { pid: Number(pid), cmd: rest.join('|') };
      });
  } catch {
    return [];
  }
}
