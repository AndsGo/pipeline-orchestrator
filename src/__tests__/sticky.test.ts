import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../projects.js';
import { readSticky, STICKY_TTL_MS, writeSticky } from '../sticky.js';

const ps: Project[] = [
  { alias: 'lakeghost', repo: 'D:/a', prefix: 'LS' },
  { alias: 'nova', repo: 'D:/b', prefix: 'NV' },
];

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-'));
  file = path.join(dir, 'sticky.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('项目粘性（单群多项目：每条消息不该都重新回答「哪个项目」）', () => {
  it('写后同群可读回；不同群互不串（A 群聊 nova 不该影响 B 群）', () => {
    writeSticky('oc_A', 'nova', file);
    expect(readSticky('oc_A', ps, Date.now(), file)?.alias).toBe('nova');
    expect(readSticky('oc_B', ps, Date.now(), file)).toBeNull();
  });

  it('TTL 过期自动失效——昨天聊的项目不该粘到今天', () => {
    writeSticky('oc_A', 'nova', file);
    const now = Date.now();
    expect(readSticky('oc_A', ps, now + STICKY_TTL_MS - 1000, file)).not.toBeNull();
    expect(readSticky('oc_A', ps, now + STICKY_TTL_MS + 1000, file)).toBeNull();
  });

  it('粘住的项目已不存在（改名/删除）→ 视为无，不指向幽灵项目', () => {
    writeSticky('oc_A', 'odoo-prodcut', file);
    expect(readSticky('oc_A', ps, Date.now(), file)).toBeNull();
  });

  it('文件损坏/缺失都不抛（粘不住顶多退回问一次）', () => {
    expect(readSticky('oc_A', ps, Date.now(), file)).toBeNull();
    fs.writeFileSync(file, '{broken', 'utf-8');
    expect(readSticky('oc_A', ps, Date.now(), file)).toBeNull();
    expect(() => writeSticky('oc_A', 'nova', file)).not.toThrow();
  });
});
