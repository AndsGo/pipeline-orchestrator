import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Do not reclaim locks automatically: read-then-unlink can delete a new owner.
 * Crash recovery requires stopping all writers before explicitly removing a lock. */
export function withFileLock<T>(file: string, fn: () => T): T {
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd: number;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('执行配置锁已存在；若持有者已退出，请停止所有写入进程后显式清理锁。不会自动回收'); throw error; }
  try { fs.writeFileSync(fd, owner); } catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  try { return fn(); }
  finally { fs.closeSync(fd); try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); } catch { /* only release our own lock */ } }
}
