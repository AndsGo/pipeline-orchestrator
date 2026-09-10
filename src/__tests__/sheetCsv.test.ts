import { describe, expect, it } from 'vitest';
import { colLetter, coverRange, parseCsv, rectangular, toCsv } from '../sheetCsv.js';

describe('sheetCsv：在线表 ↔ CSV 往返', () => {
  it('parse：引号包裹的逗号/换行/双引号，CRLF，BOM，尾行无换行', () => {
    const rows = parseCsv('﻿name,prompt\r\n"A, 1","说 ""你好""\n第二行"\r\nB,plain');
    expect(rows).toEqual([
      ['name', 'prompt'],
      ['A, 1', '说 "你好"\n第二行'],
      ['B', 'plain'],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,\n')).toEqual([['a', '']]);
  });

  it('toCsv 与 parse 互逆；需要时才加引号', () => {
    const rows = [['a', 'b,c'], ['"q"', 'x\ny'], ['', null as unknown as string]];
    const csv = toCsv(rows);
    expect(csv).toBe('a,"b,c"\n"""q""","x\ny"\n,\n');
    expect(parseCsv(csv)).toEqual([['a', 'b,c'], ['"q"', 'x\ny'], ['', '']]);
  });

  it('rectangular 补齐；colLetter：1→A、26→Z、27→AA、702→ZZ', () => {
    expect(rectangular([['a'], ['b', 'c', 'd']])).toEqual([['a', '', ''], ['b', 'c', 'd']]);
    expect([1, 26, 27, 702].map(colLetter)).toEqual(['A', 'Z', 'AA', 'ZZ']);
  });

  it('coverRange：范围盖住新旧内容的最大行列，缩短的部分写空串清掉', () => {
    const r = coverRange([['x', 'y']], [['1', '2', '3'], ['4', '5', '6']]);
    expect(r.range).toBe('A1:C2');
    expect(r.values).toEqual([['x', 'y', ''], ['', '', '']]);
    expect(coverRange([], []).range).toBe('A1:A1');
  });
});
