import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeTermsOnly,
  filterTermsByProject,
  GLOSSARY_FILE,
  matchTerms,
  readTermsFile,
  renderGlossary,
  renderTermsBrief,
  TERMS_FILE,
  writeGlossaryFile,
  type Term,
} from '../glossary.js';

let repo: string;
const TICKET = 'LS-888';
const t = (term: string, extra: Partial<Term> = {}): Term => ({ term, definition: `${term}的定义`, banned: [], ...extra });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('readTermsFile', () => {
  const write = (content: string) => {
    const dir = path.join(repo, 'docs', 'pipeline', TICKET);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, TERMS_FILE), content, 'utf-8');
  };

  it('缺失 = 无提议；合法条目读出并补默认 ticket', () => {
    expect(readTermsFile(repo, TICKET).terms).toEqual([]);
    write(JSON.stringify([{ term: '履约单', definition: '待发货执行单元', banned: ['发货单'] }]));
    const { terms, error } = readTermsFile(repo, TICKET);
    expect(error).toBeUndefined();
    expect(terms[0].ticket).toBe(TICKET);
    expect(terms[0].banned).toEqual(['发货单']);
  });

  it('JSON 坏了返回 error；畸形条目被过滤', () => {
    write('[{');
    expect(readTermsFile(repo, TICKET).error).toBeTruthy();
    write(JSON.stringify([{ term: '', definition: 'x' }, { term: 'ok', definition: '' }, { term: '好词', definition: '有定义' }]));
    expect(readTermsFile(repo, TICKET).terms.map((x) => x.term)).toEqual(['好词']);
  });
});

describe('过滤与命中', () => {
  it('状态门：只放行生效，无状态视同生效', () => {
    const out = activeTermsOnly([t('a', { status: '生效' }), t('b', { status: '待审' }), t('c')]);
    expect(out.map((x) => x.term)).toEqual(['a', 'c']);
  });

  it('项目过滤：本项目 + 未标项目的通用词', () => {
    const out = filterTermsByProject([t('a', { project: 'lakeghost' }), t('b', { project: 'other' }), t('c')], 'lakeghost');
    expect(out.map((x) => x.term)).toEqual(['a', 'c']);
  });

  it('命中：规范词或禁用同义词出现都算', () => {
    const terms = [t('履约单', { banned: ['发货单'] }), t('渠道价')];
    expect(matchTerms('发货单怎么拆分', terms).map((x) => x.term)).toEqual(['履约单']);
    expect(matchTerms('渠道价和结算价的区别', terms).map((x) => x.term)).toEqual(['渠道价']);
    expect(matchTerms('无关内容', terms)).toEqual([]);
  });
});

describe('渲染与落盘', () => {
  it('完整版含用词纪律，紧凑版含禁用提示', () => {
    const terms = [t('履约单', { banned: ['发货单', '出库单'], domain: '订单履约' })];
    const full = renderGlossary(terms);
    expect(full).toContain('用「履约单」，不要用「发货单」「出库单」');
    expect(full).toContain('订单履约');
    expect(renderTermsBrief(terms)).toContain('不要说「发货单」');
  });

  it('写入与空表删除', () => {
    const f = path.join(repo, 'docs', 'pipeline', TICKET, GLOSSARY_FILE);
    expect(writeGlossaryFile(repo, TICKET, [t('a')])).toBe(true);
    expect(fs.existsSync(f)).toBe(true);
    expect(writeGlossaryFile(repo, TICKET, [])).toBe(false);
    expect(fs.existsSync(f)).toBe(false);
  });
});
