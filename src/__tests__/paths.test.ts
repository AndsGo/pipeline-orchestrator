import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeFile } from '../paths.js';

describe('removeFile', () => {
  // 回归护栏：这里若换回 fs.rmSync，Node 24.13/Windows 会让整个测试进程以 0xC0000409 退出（daemon 六次无声消失的根因）
  it('能删路径里带中文的文件，不存在时静默', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
    const f = path.join(dir, '结合标题描述的场景化测试结果(282条).csv');
    fs.writeFileSync(f, 'x');
    removeFile(f);
    expect(fs.existsSync(f)).toBe(false);
    expect(() => removeFile(f)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
