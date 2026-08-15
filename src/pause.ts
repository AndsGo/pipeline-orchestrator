import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P1 逃生舱：pause 信号文件。
 * 任何人（bridge bot / 本机命令 npm run pause -- <ticket>）创建该文件，
 * 编排器在下一个阶段边界安全停住；重新 start-ticket 即恢复（启动时清除信号）。
 */

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

export function pauseFile(ticket: string): string {
  return path.join(DATA_DIR, `${ticket}.pause`);
}

export function isPaused(ticket: string): boolean {
  return fs.existsSync(pauseFile(ticket));
}

export function setPaused(ticket: string, by = 'unknown'): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(pauseFile(ticket), JSON.stringify({ at: new Date().toISOString(), by }), 'utf-8');
}

export function clearPaused(ticket: string): void {
  try {
    fs.unlinkSync(pauseFile(ticket));
  } catch {
    /* 不存在即目标态 */
  }
}
