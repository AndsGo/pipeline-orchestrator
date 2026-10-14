import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';

const context = new AsyncLocalStorage<string>();
export const withInvocationTicket = <T>(ticket: string, fn: () => T): T => context.run(ticket, fn);
interface Invocation { id: string; ticket: string; ownerPid: number; spawnedAt: string; command: string; cwd: string; pid?: number; }
const directory = () => path.join(dataDir(), 'invocations');
/** Persist intent before spawn: an interrupted launch must never be mistaken for idle. */
export function beginInvocation(command: string, cwd: string): { spawned: (pid: number) => void; closed: () => void } | undefined {
  const ticket = context.getStore();
  if (!ticket) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ticket)) throw new Error('调用工单标识不合法');
  fs.mkdirSync(directory(), { recursive: true });
  const record: Invocation = { id: randomUUID(), ticket, ownerPid: process.pid, spawnedAt: new Date().toISOString(), command, cwd };
  const file = path.join(directory(), `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    spawned(pid) {
      record.pid = pid;
      const temp = `${file}.tmp`;
      try { fs.writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, file); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    },
    closed() { if (fs.existsSync(file)) fs.unlinkSync(file); },
  };
}
export function trackedInvocations(ticket: string, alive: (pid: number) => boolean): Array<{ pid: number; cmd: string }> {
  if (!fs.existsSync(directory())) return [];
  const result: Array<{ pid: number; cmd: string }> = [];
  for (const name of fs.readdirSync(directory()).filter(n => n.endsWith('.json'))) {
    const file = path.join(directory(), name);
    let r: Invocation;
    try { r = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('调用进程记录损坏；无法安全判断是否存在孤儿会话，请检查 data/invocations'); }
    if (!r || typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/.test(r.id) || typeof r.ticket !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.ticket) || !Number.isInteger(r.ownerPid) || r.ownerPid <= 0 || typeof r.spawnedAt !== 'string' || !Number.isFinite(Date.parse(r.spawnedAt)) || typeof r.command !== 'string' || !r.command || typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd) || (r.pid !== undefined && (!Number.isInteger(r.pid) || r.pid <= 0))) throw new Error('调用进程记录字段不合法；无法安全恢复，请检查 data/invocations');
    if (r.ticket !== ticket) continue;
    if (r.pid && alive(r.pid)) result.push({ pid: r.pid, cmd: `${r.command}（工单 ${ticket}，启动 ${r.spawnedAt}；清理前核对 PID 未复用）` });
    else if (!r.pid) result.push({ pid: r.ownerPid, cmd: `未确认的 CLI 启动记录 ${r.id}；请核实进程树后清理该记录` });
    else fs.unlinkSync(file);
  }
  return result;
}
