import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectOutbox, imFileType, isImage, outboxDir, outboxPromptLine, recentImages } from '../outbox.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));

describe('outbox：会话出件箱 → 编排器代发飞书文件', () => {
  it('file_type 映射：xlsx→xls、docx→doc、pptx→ppt、pdf、mp4、opus；csv/zip/未知走 stream', () => {
    expect(imFileType('结果.xlsx')).toBe('xls');
    expect(imFileType('a.XLS')).toBe('xls');
    expect(imFileType('a.docx')).toBe('doc');
    expect(imFileType('a.pptx')).toBe('ppt');
    expect(imFileType('a.pdf')).toBe('pdf');
    expect(imFileType('a.mp4')).toBe('mp4');
    expect(imFileType('a.opus')).toBe('opus');
    expect(imFileType('a.csv')).toBe('stream');
    expect(imFileType('a.zip')).toBe('stream');
    expect(imFileType('noext')).toBe('stream');
    expect(isImage('shot.PNG')).toBe(true);
    expect(isImage('a.xlsx')).toBe(false);
  });

  it('collectOutbox：空文件与超限的进 skipped 并说明原因；子目录忽略；目录不存在返回空', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'ok.csv'), 'a,b\n');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(11));
    fs.mkdirSync(path.join(dir, 'sub'));
    const r = collectOutbox(dir, 10);
    expect(r.files.map((f) => path.basename(f))).toEqual(['ok.csv']);
    expect(r.skipped).toEqual(['big.bin（0.0MB，超过 0.0000095367431640625MB 上限）', 'empty.txt（空文件）']);
    expect(collectOutbox(path.join(dir, 'nope'))).toEqual({ files: [], skipped: [] });
  });

  it('outboxDir 用正斜杠（进提示词给 bash 用）；提示词句子含目录与 30MB 上限', () => {
    const d = outboxDir('run-1');
    expect(d).not.toContain('\\');
    expect(d.endsWith('/outbox/run-1')).toBe(true);
    expect(outboxPromptLine(d)).toContain(d);
    expect(outboxPromptLine(d)).toContain('30MB');
  });

  it('recentImages：只取 since 之后改动的非空图片，按名排序', () => {
    const dir = tmp();
    const old = path.join(dir, 'old.png');
    fs.writeFileSync(old, 'x');
    fs.utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    fs.writeFileSync(path.join(dir, 'b.png'), 'x');
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'note.md'), 'x');
    fs.writeFileSync(path.join(dir, 'empty.png'), '');
    const since = Date.now() - 10_000;
    expect(recentImages(dir, since).map((f) => path.basename(f))).toEqual(['a.jpg', 'b.png']);
    expect(recentImages(path.join(dir, 'nope'), 0)).toEqual([]);
  });
});
