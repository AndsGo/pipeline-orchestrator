import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import { BitableBoard } from '../bitable/client.js';

let sequence = 0;
function fixture() {
  const records = {
    search: vi.fn(async () => ({ code: 0, data: { items: [] as Array<{ record_id: string }>, has_more: false } })),
    create: vi.fn(async () => ({ code: 0, data: { record: { record_id: 'record-1' } } })),
    update: vi.fn(async () => ({ code: 0 })),
  };
  const client = { bitable: { appTableRecord: records } } as unknown as Client;
  const cfg = { appToken: `test-${++sequence}`, reqTableId: 'requirements', ticketTableId: 'tickets', nodeTableId: 'nodes' };
  return { records, board: () => new BitableBoard(client, cfg) };
}

describe('需求飞书投影', () => {
  it('不同 Board 实例并发保存同一需求只创建一次，后续更新同一 ID，按提交顺序写入', async () => {
    const f = fixture();
    await Promise.all([f.board().upsertReq('REQ-001', { 标题: '待整理' }), f.board().upsertReq('REQ-001', { 标题: '已提炼' })]);
    expect(f.records.create).toHaveBeenCalledTimes(1);
    expect(f.records.search).toHaveBeenCalledTimes(1);
    expect(f.records.update).toHaveBeenCalledWith(expect.objectContaining({ path: expect.objectContaining({ record_id: 'record-1' }), data: { fields: { 标题: '已提炼' } } }));
  });
  it('查询异常或业务错误时不创建，失败不会堵住后续同步', async () => {
    const f = fixture();
    f.records.search.mockRejectedValueOnce(new Error('network'));
    await expect(f.board().upsertReq('REQ-001', {})).rejects.toThrow('network');
    f.records.search.mockResolvedValueOnce({ code: 999, data: { items: [], has_more: false } });
    await expect(f.board().upsertReq('REQ-001', {})).rejects.toThrow('查询失败');
    expect(f.records.create).not.toHaveBeenCalled();
    await f.board().upsertReq('REQ-001', {});
    expect(f.records.create).toHaveBeenCalledTimes(1);
  });
  it('创建响应丢失后不盲目再建，搜索到原记录后恢复更新', async () => {
    const f = fixture();
    f.records.create.mockRejectedValueOnce(new Error('timeout'));
    await expect(f.board().upsertReq('REQ-001', {})).rejects.toThrow('timeout');
    await expect(f.board().upsertReq('REQ-001', {})).rejects.toThrow('结果不确定');
    f.records.search.mockResolvedValueOnce({ code: 0, data: { items: [{ record_id: 'original' }], has_more: false } });
    await f.board().upsertReq('REQ-001', {});
    expect(f.records.create).toHaveBeenCalledTimes(1);
    expect(f.records.update).toHaveBeenCalledTimes(1);
  });
  it('更新失败不创建替代行，发现已有重复也不任意覆盖', async () => {
    const f = fixture();
    f.records.search.mockResolvedValueOnce({ code: 0, data: { items: [{ record_id: 'existing' }], has_more: false } });
    f.records.update.mockResolvedValueOnce({ code: 999 });
    await expect(f.board().upsertReq('REQ-001', {})).rejects.toThrow('更新失败');
    f.records.search.mockResolvedValueOnce({ code: 0, data: { items: [{ record_id: 'a' }, { record_id: 'b' }], has_more: false } });
    await expect(f.board().upsertReq('REQ-002', {})).rejects.toThrow('重复记录');
    expect(f.records.create).not.toHaveBeenCalled();
  });
});
