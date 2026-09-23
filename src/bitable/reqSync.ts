import type { Requirement } from '../requirements.js';
import { BitableBoard } from './client.js';

/** 需求 → 需求池表的一行（纯函数，便于单测） */
export function reqRow(r: Requirement): Record<string, unknown> {
  return {
    需求号: r.id,
    项目: r.project,
    标题: r.title,
    状态: r.status,
    提出人: r.requester,
    建议拆分: (r.splits ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    关联工单: r.tickets.join('、'),
    备注: r.note ?? '',
    // 文本单元格有长度上限，说明全文以文件为准
    需求说明: (r.brief ?? r.raw).slice(0, 5000),
    创建时间: Date.parse(r.createdAt),
    最后更新: Date.parse(r.updatedAt),
  };
}

/** 单向投影：未配表 / 未配凭据时什么也不做 */
export async function projectReq(r: Requirement): Promise<void> {
  const board = BitableBoard.fromEnv();
  if (!board) return;
  await board.upsertReq(r.id, reqRow(r));
}
