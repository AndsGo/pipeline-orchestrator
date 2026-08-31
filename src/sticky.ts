import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './projects.js';

/**
 * 项目粘性（2026-08-31）：群里说过一次「odoo-product 项目，分析下…」之后，
 * 后续消息默认沿用该项目，不再回落全局默认、不再弹项目选择卡。
 * 由来：多项目接入首日，速卖通提问静默落到 lakeghost 白跑一次；「导出」一句
 * 因判不出项目要人再选一次——单群多项目下每条消息都被迫重新回答「哪个项目」。
 * 防误触两件套：执行回执始终写明「在 X 上执行」；TTL 过期自动回默认。
 * 绑定群（Project.chatId 命中）不记粘性——群即项目，粘性只服务未绑定的群。
 */

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/sticky-project.json');

export const STICKY_TTL_MS = 4 * 3600_000;

type StickyMap = Record<string, { alias: string; at: string }>;

function readMap(file: string): StickyMap {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as StickyMap;
  } catch {
    return {};
  }
}

/** 本群当前粘住的项目；过期、项目已不存在（改名/删除）都视为无 */
export function readSticky(chatId: string, projects: Project[], now = Date.now(), file = FILE): Project | null {
  const rec = readMap(file)[chatId];
  if (!rec) return null;
  if (now - Date.parse(rec.at) > STICKY_TTL_MS) return null;
  return projects.find((p) => p.alias === rec.alias) ?? null;
}

/** 记粘性（写失败不抛：粘不住顶多退回问一次，不能反过来影响主流程） */
export function writeSticky(chatId: string, alias: string, file = FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const map = readMap(file);
    map[chatId] = { alias, at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(map), 'utf-8');
  } catch {
    /* 见上 */
  }
}
