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
