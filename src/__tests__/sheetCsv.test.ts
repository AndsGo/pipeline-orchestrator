import { describe, expect, it } from 'vitest';
import { colLetter, coverRange, diffRanges, IMAGE_PLACEHOLDER, linkifyCells, parseCsv, planAssets, rectangular, sheetFileName, toCsv, trimEmpty } from '../sheetCsv.js';

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

  it('trimEmpty：去掉尾部空行与每行尾部空格子（导入默认 200×20 网格全是空串）', () => {
    expect(trimEmpty([['a', '', ''], ['', 'b', ''], ['', '', ''], ['', '', '']])).toEqual([['a'], ['', 'b']]);
    expect(trimEmpty([['', ''], ['', '']])).toEqual([]);
  });

  it('sheetFileName：工作表标题去掉禁用字符后作 csv 文件名；空标题回落 Sheet', () => {
    expect(sheetFileName('两步生成测试结果')).toBe('两步生成测试结果.csv');
    expect(sheetFileName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i.csv');
    expect(sheetFileName('  ')).toBe('Sheet.csv');
  });

  it('linkifyCells：整格等于文件名换成链接；格内提到文件名补「（链接）」；已含链接不重复；无映射原样返回', () => {
    const links = { 'a.png': 'https://x/a', 'a.png.bak': 'https://x/b' };
    const rows = [['类目', 'a.png', '见 a.png 与 a.png.bak'], ['已挂 a.png（https://x/a）', 'none']];
    expect(linkifyCells(rows, links)).toEqual([
      ['类目', 'https://x/a', '见 a.png（https://x/a） 与 a.png.bak（https://x/b）'],
      ['已挂 a.png（https://x/a）', 'none'],
    ]);
    expect(linkifyCells(rows, {})).toBe(rows);
  });

  it('diffRanges：只写改动的格子，按行分连续段；嵌图占位未变不碰；缩短部分写空清掉', () => {
    const old = [['a', IMAGE_PLACEHOLDER, 'c', 'd'], ['e', 'f'], ['g']];
    const cur = [['a', IMAGE_PLACEHOLDER, 'C', 'D'], ['e', 'f', 'x'], []];
    expect(diffRanges(cur, old)).toEqual([
      { range: 'C1:D1', values: [['C', 'D']] },
      { range: 'C2:C2', values: [['x']] },
      { range: 'A3:A3', values: [['']] },
    ]);
    expect(diffRanges([['same']], [['same']])).toEqual([]);
    // 整格从图片改成文字：算改动（人明确要换掉）
    expect(diffRanges([['t']], [[IMAGE_PLACEHOLDER]])).toEqual([{ range: 'A1:A1', values: [['t']] }]);
  });

  it('planAssets：整格等于图片文件名 → 嵌入；文字里提到 / 非图片 / 没提到 → 链接', () => {
    const rows = [[['类目', 'a.png', '见 b.png'], ['x', 'c.pdf', '']]];
    const p = planAssets(rows, ['a.png', 'b.png', 'c.pdf', 'd.jpg']);
    expect([...p.embed]).toEqual(['a.png']);
    expect([...p.link].sort()).toEqual(['b.png', 'c.pdf', 'd.jpg']);
  });

  it('coverRange：范围盖住新旧内容的最大行列，缩短的部分写空串清掉', () => {
    const r = coverRange([['x', 'y']], [['1', '2', '3'], ['4', '5', '6']]);
    expect(r.range).toBe('A1:C2');
    expect(r.values).toEqual([['x', 'y', ''], ['', '', '']]);
    expect(coverRange([], []).range).toBe('A1:A1');
  });
});
