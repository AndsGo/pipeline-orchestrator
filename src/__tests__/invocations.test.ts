import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginInvocation, trackedInvocations, withInvocationTicket } from '../engine/invocations.js';
import { runProcess, stopProcessTree, withProcessEvidence, type ProcessEvidence } from '../engine/process.js';
import { defaultPidAlive, findOrphanClaude } from '../lock.js';

let root: string;
const previous = process.env.PIPELINE_DATA_DIR;
const children: number[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-invocation-')); process.env.PIPELINE_DATA_DIR = root; });
afterEach(() => {
  for (const pid of children.splice(0)) if (defaultPidAlive(pid)) stopProcessTree({ pid } as ChildProcess);
  if (previous === undefined) delete process.env.PIPELINE_DATA_DIR; else process.env.PIPELINE_DATA_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
describe('persistent CLI invocation recovery', () => {
  it('captures partial output from a timed-out CLI without exposing its input or argv', async () => {
    const captured: ProcessEvidence[] = [];
    await expect(withProcessEvidence(result => captured.push(result), () => runProcess(process.execPath,
      ['-e', 'process.stdout.write("partial evidence"); setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 700, stdin: 'private prompt' }))).rejects.toThrow('超时');
    expect(captured).toHaveLength(1); expect(captured[0].stdout).toBe('partial evidence');
    expect(captured[0].failure).toContain('超时'); expect(captured[0]).not.toHaveProperty('stdin'); expect(captured[0]).not.toHaveProperty('args');
    expect(JSON.stringify(captured)).not.toContain('private prompt');
  });
  it('records ticket identity outside argv and removes the record on normal exit', async () => {
    const result = await withInvocationTicket('DM-30', () => runProcess(process.execPath, ['-e', 'process.stdout.write("OK")'], { cwd: root, timeoutMs: 5000, stdin: 'secret prompt' }));
    expect(result.stdout).toBe('OK');
    expect(trackedInvocations('DM-30', defaultPidAlive)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'invocations'))).toEqual([]);
  });
  it('a CLI timeout terminates its tracked process and cleans the recovery record', async () => {
    const running = withInvocationTicket('DM-33', () => runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 200 }));
    const recordFile = path.join(root, 'invocations', fs.readdirSync(path.join(root, 'invocations'))[0]);
    const { pid } = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    children.push(pid);
    await expect(running).rejects.toThrow('超时');
    expect(defaultPidAlive(pid)).toBe(false);
    expect(fs.readdirSync(path.join(root, 'invocations'))).toEqual([]);
  });
  it('an unconfirmed launch or malformed record blocks recovery conservatively', () => {
    const invocation = withInvocationTicket('DM-31', () => beginInvocation('fake-cli', root))!;
    expect(trackedInvocations('DM-31', () => false)[0].cmd).toContain('未确认');
    invocation.closed();
    fs.writeFileSync(path.join(root, 'invocations/broken.json'), '{');
    expect(() => trackedInvocations('DM-31', () => false)).toThrow('记录损坏');
    fs.writeFileSync(path.join(root, 'invocations/broken.json'), '{}');
    expect(() => trackedInvocations('DM-31', () => false)).toThrow('字段不合法');
  });
  it('a recovery controller detects a live stdin CLI using a dead-owner manifest', async () => {
    const running = withInvocationTicket('DM-32', () => runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 10000, stdin: 'prompt not in argv' }));
    const records = fs.readdirSync(path.join(root, 'invocations'));
    expect(records).toHaveLength(1);
    const recordFile = path.join(root, 'invocations', records[0]);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    record.ownerPid = 99999999; // Simulate the persisted identity of a controller that has exited.
    fs.writeFileSync(recordFile, JSON.stringify(record));
    children.push(record.pid);
    try {
      const orphans = findOrphanClaude('DM-32');
      expect(orphans).toHaveLength(1);
      expect(defaultPidAlive(orphans[0].pid)).toBe(true);
      expect(orphans[0].cmd).toContain('DM-32');
      expect(orphans[0].cmd).not.toContain('prompt not in argv');
    } finally { stopProcessTree({ pid: record.pid } as ChildProcess); await running; }
  });
});
