/**
 * 在线电子表格 ↔ CSV 的往返（纯函数）。
 * 会话只会读写本地 CSV（沙箱不碰飞书 token）；编排器负责和电子表格的 values 接口互转。
 * RFC 4180 子集：逗号分隔、双引号包裹含逗号/引号/换行的单元格、引号转义为两个引号；\r\n 与 \n 都认。
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n') + (rows.length ? '\n' : '');
}

/** 去掉尾部全空的行与每行尾部的空格子（导入产生的 200×20 默认网格读出来全是空串） */
export function trimEmpty(rows: string[][]): string[][] {
  const out = rows.map((r) => {
    let end = r.length;
    while (end > 0 && r[end - 1] === '') end--;
    return r.slice(0, end);
  });
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

/** 工作表标题 → 文件名（去掉路径分隔符与 Windows 禁用字符） */
export function sheetFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Sheet'}.csv`;
}

/**
 * 把单元格里的附件文件名换成链接：整格等于文件名 → 链接；格内提到文件名 → 原文后接「（链接）」。
 * 会话在表里只写文件名（它拿不到 URL），编排器上传后再替换
 */
export function linkifyCells(rows: string[][], links: Record<string, string>): string[][] {
  const names = Object.keys(links).sort((a, b) => b.length - a.length);
  if (!names.length) return rows;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 整词匹配：a.png 不能命中 a.png.bak 里的前缀；已跟着「（」的（上一轮挂过链接）不重复
  const res = names.map((n) => [n, new RegExp(`(?<![\\w.\\-])${esc(n)}(?![\\w.\\-（])`, 'g')] as const);
  return rows.map((r) =>
    r.map((cell) => {
      if (links[cell.trim()]) return links[cell.trim()];
      let out = cell;
      for (const [n, re] of res) out = out.replace(re, `${n}（${links[n]}）`);
      return out;
    }),
  );
}

/** 单元格里嵌着图片时读出来的占位（读接口给的是对象；写回时占位不变就不碰那一格，图片才不会被冲掉） */
export const IMAGE_PLACEHOLDER = '[图片]';

/**
 * 差量写回：只写改动的格子（按行分成连续段），没改的——尤其是嵌图格——一个字节都不碰。
 * 新表比旧表短的部分写空串清掉。返回 values_batch_update 用的段列表
 */
export function diffRanges(newRows: string[][], oldRows: string[][]): Array<{ range: string; values: string[][] }> {
  const rows = Math.max(newRows.length, oldRows.length);
  const out: Array<{ range: string; values: string[][] }> = [];
  for (let r = 0; r < rows; r++) {
    const nr = newRows[r] ?? [];
    const or = oldRows[r] ?? [];
    const cols = Math.max(nr.length, or.length);
    let start = -1;
    let seg: string[] = [];
    const flush = (end: number): void => {
      if (start >= 0) out.push({ range: `${colLetter(start + 1)}${r + 1}:${colLetter(end)}${r + 1}`, values: [seg] });
      start = -1;
      seg = [];
    };
    for (let c = 0; c < cols; c++) {
      const nv = nr[c] ?? '';
      const ov = or[c] ?? '';
      if (nv === ov) {
        flush(c);
        continue;
      }
      if (start < 0) start = c;
      seg.push(nv);
    }
    flush(cols);
  }
  return out;
}

/**
 * 附件去向：整格等于图片文件名 → 嵌进单元格（embed）；只在文字里提到、或不是图片 → 上传附件夹挂链接（link）。
 * 没被任何格子提到的附件也走 link（至少人能在附件夹里找到）
 */
export function planAssets(rowsByCsv: string[][][], assetNames: string[]): { embed: Set<string>; link: Set<string> } {
  const embed = new Set<string>();
  const cells = new Set<string>();
  for (const rows of rowsByCsv) for (const r of rows) for (const cell of r) cells.add(cell.trim());
  for (const n of assetNames) if (/\.(png|jpe?g|gif|bmp|heic|tiff?)$/i.test(n) && cells.has(n)) embed.add(n);
  return { embed, link: new Set(assetNames.filter((n) => !embed.has(n))) };
}

/** 补齐成矩形（电子表格写入要求每行等长），空位用空串 */
export function rectangular(rows: string[][]): string[][] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => [...r, ...Array<string>(Math.max(0, width - r.length)).fill('')]);
}

/** 列号 → 字母（1 → A，27 → AA） */
export function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** 覆盖写入用的 A1 范围：从 A1 起，至少盖住旧内容的行列，多出来的位置写空串把旧数据清掉 */
export function coverRange(newRows: string[][], oldRows: string[][]): { range: string; values: string[][] } {
  const rows = Math.max(newRows.length, oldRows.length, 1);
  const cols = Math.max(...newRows.map((r) => r.length), ...oldRows.map((r) => r.length), 1);
  const values: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const src = newRows[r] ?? [];
    values.push(Array.from({ length: cols }, (_, c) => src[c] ?? ''));
  }
  return { range: `A1:${colLetter(cols)}${rows}`, values };
}
