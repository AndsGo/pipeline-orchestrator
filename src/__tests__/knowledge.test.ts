import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sanitizeBlocks } from '../feishu/docs.js';
import { HINTS_FILE, keywords, readKnowledgeFile, renderHints, scoreEntry, selectHints, writeHints, type KnowledgeEntry } from '../knowledge.js';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
const T = 'KB-1';
const dir = path.join(repo, 'docs/pipeline', T);
fs.mkdirSync(dir, { recursive: true });
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  title: '反向代理新增暴露路径必须同步三份 nginx 配置',
  kind: '踩坑',
  tags: ['nginx', '部署'],
  symptom: '新端点部署后请求落回前端页面',
  cause: '只改了一份代理配置',
  practice: '列全部代理配置逐一确认',
  ...over,
});

describe('知识条目读取', () => {
  it('合法数组正常解析并补上来源工单', () => {
    fs.writeFileSync(path.join(dir, '96-knowledge.json'), JSON.stringify([entry()]), 'utf-8');
    const { entries, error } = readKnowledgeFile(repo, T);
    expect(error).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0].ticket).toBe(T);
  });

  it('非法 JSON / 缺必填字段 → 不投脏数据，且报告原因', () => {
    fs.writeFileSync(path.join(dir, '96-knowledge.json'), '{ not json', 'utf-8');
    expect(readKnowledgeFile(repo, T).error).toBeTruthy();
    fs.writeFileSync(path.join(dir, '96-knowledge.json'), JSON.stringify([{ kind: '踩坑' }, entry()]), 'utf-8');
    expect(readKnowledgeFile(repo, T).entries).toHaveLength(1); // 缺 title 的被丢掉
  });

  it('文件不存在时返回空且无错误（沉淀无经验是正常情况）', () => {
    expect(readKnowledgeFile(repo, 'NOPE')).toEqual({ entries: [] });
  });
});

describe('提示预取与排序', () => {
  it('条目少于上限时全给', () => {
    const all = [entry(), entry({ title: 'B' })];
    expect(selectHints(all, '随便', 12)).toHaveLength(2);
  });

  it('超过上限时按相关性取前 N（命中标签/标题的排前面）', () => {
    const noise = Array.from({ length: 20 }, (_, i) => entry({ title: `无关条目${i}`, tags: ['其他'], symptom: '无' }));
    const hit = entry({ title: 'nginx 限流配置踩坑', tags: ['nginx'] });
    const picked = selectHints([...noise, hit], '给 nginx 的 /mcp 端点加限流', 3);
    expect(picked.map((p) => p.title)).toContain('nginx 限流配置踩坑');
    expect(picked).toHaveLength(3);
  });

  it('关键词提取覆盖中英混排', () => {
    const w = keywords('给 nginx 的 /mcp 端点加限流');
    expect(w).toContain('nginx');
    expect(w.some((x) => x.includes('限流'))).toBe(true);
  });

  it('打分：长词权重更高，完全不相关得 0', () => {
    expect(scoreEntry(entry(), ['nginx'])).toBeGreaterThan(0);
    expect(scoreEntry(entry(), ['完全无关的词'])).toBe(0);
  });
});

describe('云文档块净化（真机 invalid param 回归）', () => {
  it('表格块必须剥掉 merge_info，其余字段保留', () => {
    const { blocks } = sanitizeBlocks([
      { block_id: 't', block_type: 31, table: { property: { row_size: 2, column_size: 3, merge_info: [{ row_span: 1 }] } } },
      { block_id: 'p', block_type: 2, text: { elements: [] } },
    ] as never);
    const tbl = blocks[0] as { table: { property: Record<string, unknown> } };
    expect(tbl.table.property.merge_info).toBeUndefined();
    expect(tbl.table.property.row_size).toBe(2);
    expect(blocks[1]).toMatchObject({ block_type: 2 }); // 非表格块原样透传
  });

  it('图片块降级为文字说明并计数（素材需另传，不能整批失败）', () => {
    const { blocks, droppedImages } = sanitizeBlocks([{ block_id: 'i', block_type: 27, image: { token: 'x' } }] as never);
    expect(droppedImages).toBe(1);
    expect(blocks[0]).toMatchObject({ block_type: 2 });
    expect(JSON.stringify(blocks[0])).toContain('git 工件');
  });
});

describe('提示文件渲染与写入', () => {
  it('渲染包含"不是本单需求"的免责说明（防把历史经验当需求）', () => {
    const md = renderHints([entry()]);
    expect(md).toContain('不是本单的需求');
    expect(md).toContain('nginx');
    expect(md).toContain('正确做法');
  });

  it('无条目时删除旧提示文件，避免上一轮提示误导本轮', () => {
    writeHints(repo, T, [entry()]);
    expect(fs.existsSync(path.join(dir, HINTS_FILE))).toBe(true);
    expect(writeHints(repo, T, [])).toBe(false);
    expect(fs.existsSync(path.join(dir, HINTS_FILE))).toBe(false);
  });
});
