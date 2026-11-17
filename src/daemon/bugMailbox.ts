import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';

export interface BugRequest {
  id: string;
  expectedRevision: number;
  requestId: string;
  by: string;
  operation: 'start-fix' | 'investigate';
  /** Set by the local console server, never copied from request JSON. */
  channel?: 'console' | 'feishu';
}
export interface StoredBugRequest extends BugRequest {
  createdAt: string;
  completedAt?: string;
  error?: string;
}
const directory = () => path.join(dataDir(), 'bug-requests');
function filename(requestId: string): string {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Error('Bug requestId 不合法');
  return path.join(directory(), `${requestId}.json`);
}
/** One durable file per operation; acknowledgement happens only after processing. */
export function enqueueBugRequest(request: BugRequest): StoredBugRequest {
  if (!request.by?.trim() || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || !['start-fix', 'investigate'].includes(request.operation) || !/^BUG-\d{3,}$/i.test(request.id)) throw new Error('Bug 执行请求不合法');
  fs.mkdirSync(directory(), { recursive: true });
  const file = filename(request.requestId);
  const stored = { ...request, createdAt: new Date().toISOString() };
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(stored), 'utf8');
  try { fs.linkSync(temp, file); return stored; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredBugRequest;
    if (['id', 'expectedRevision', 'by', 'operation', 'channel'].some(key => previous[key as keyof BugRequest] !== request[key as keyof BugRequest])) throw new Error('requestId 已用于另一项 Bug 操作');
    return readBugRequest(request.requestId) ?? previous;
  } finally { fs.unlinkSync(temp); }
}
export function pendingBugRequests(): StoredBugRequest[] {
  if (!fs.existsSync(directory())) return [];
  return fs.readdirSync(directory()).filter(name => name.endsWith('.json') && !name.endsWith('.result.json'))
    .map(name => readBugRequest(name.slice(0, -5))!).filter(request => request && !request.completedAt);
}
export function readBugRequest(requestId: string): StoredBugRequest | null {
  try {
    const file = filename(requestId);
    const request = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredBugRequest;
    return fs.existsSync(`${file}.result.json`) ? { ...request, ...JSON.parse(fs.readFileSync(`${file}.result.json`, 'utf8')) } : request;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function acknowledgeBugRequest(request: StoredBugRequest, error?: string): void {
  const file = `${filename(request.requestId)}.result.json`;
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ completedAt: new Date().toISOString(), ...(error ? { error } : {}) }), 'utf8');
  try { fs.linkSync(temp, file); }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
  finally { fs.unlinkSync(temp); }
}
