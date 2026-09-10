import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

/**
 * 出件箱：会话要交给人的文件（xlsx / csv / 截图…）写到这里，编排器结束后代为上传发进群/话题。
 * 会话是无人值守沙箱，不该拿飞书 token；由编排器上传（im/v1/files、im/v1/images）是唯一合规通道。
 * 真机由来（2026-09-10）：话题里让会话「把测试结果 xlsx 发到群里」，会话只能给出本机路径。
 */

/** 飞书 IM 文件消息上限：30MB，且不接受空文件 */
export const OUTBOX_MAX_BYTES = 30 * 1024 * 1024;

export function outboxDir(runId: string): string {
  return path.join(dataDir(), 'outbox', runId).replace(/\\/g, '/');
}

export const isImage = (name: string): boolean => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

/** im/v1/files 的 file_type 枚举只有 opus/mp4/pdf/doc/xls/ppt/stream；xlsx→xls、docx→doc、pptx→ppt，其余（csv/zip/txt…）走 stream */
export function imFileType(name: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.opus') return 'opus';
  if (ext === '.mp4') return 'mp4';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'doc';
  if (ext === '.xls' || ext === '.xlsx') return 'xls';
  if (ext === '.ppt' || ext === '.pptx') return 'ppt';
  return 'stream';
}

/** 收集可发送的文件（只看一层）；空文件与超限的列进 skipped 并说明原因 */
export function collectOutbox(dir: string, maxBytes = OUTBOX_MAX_BYTES): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(dir)) return { files, skipped };
  for (const name of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size === 0) skipped.push(`${name}（空文件）`);
    else if (st.size > maxBytes) skipped.push(`${name}（${(st.size / 1024 / 1024).toFixed(1)}MB，超过 ${maxBytes / 1024 / 1024}MB 上限）`);
    else files.push(f);
  }
  return { files, skipped };
}

/** 提示词里告诉会话出件箱在哪、怎么用 */
export function outboxPromptLine(dir: string): string {
  return `要交给用户的文件（表格 / 截图 / 导出结果等）请写到目录 ${dir}/ 下（已存在，用 Bash 写入即可），并在正文里提一句文件名与内容——结束后我会把该目录里的文件上传并发到用户所在的群/话题（单个 ≤30MB）。不要把文件写到别处再让用户自己去找。`;
}

/** 某目录里在 sinceMs 之后改动过的图片（验收 e2e 截图随结果一起发） */
export function recentImages(dir: string, sinceMs: number): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => isImage(n))
    .map((n) => path.join(dir, n))
    .filter((f) => {
      try {
        const st = fs.statSync(f);
        return st.isFile() && st.size > 0 && st.size <= OUTBOX_MAX_BYTES && st.mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    })
    .sort();
}
