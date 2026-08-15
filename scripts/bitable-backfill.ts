// 回填：把历史工单的事件重放进看板（表结构变更后也可重跑，节点行按幂等键去重）。
// 用法: npx tsx scripts/bitable-backfill.ts [工单号...]   省略则回填全部
import { BitableBoard } from '../src/bitable/client.js';
import { listTickets, readEvents } from '../src/events.js';
import { nodeRow, ticketRow } from '../src/bitable/project.js';
import { projectCfgFromEnv } from '../src/bitable/sync.js';
import { readSnapshot } from '../src/ticket.js';

const board = BitableBoard.fromEnv();
if (!board) {
  console.error('缺少 BITABLE_* 或 FEISHU_* 配置');
  process.exit(1);
}
const cfg = projectCfgFromEnv();
const tickets = process.argv.slice(2).length ? process.argv.slice(2) : listTickets();

for (const ticket of tickets) {
  const state = readSnapshot(ticket);
  const events = readEvents(ticket);
  if (!state) {
    console.log(`- ${ticket}：无快照，跳过`);
    continue;
  }
  const roundOf = (stage: string) => events.filter((e) => e.type === 'stage.end' && e.stage === stage).length;
  const recordId = await board.upsertTicket(ticket, ticketRow(state, events, cfg, false));
  let n = 0;
  // 轮次按时间顺序累加，保证第 N 轮标注正确
  const seen: Record<string, number> = {};
  for (const ev of events) {
    const localRound = (stage: string) => seen[stage] ?? 0;
    if (ev.type === 'stage.end' && ev.stage) seen[ev.stage] = (seen[ev.stage] ?? 0) + 1;
    const row = nodeRow(ev, state, cfg, ev.type === 'stage.end' ? localRound : roundOf);
    if (row) {
      await board.appendNode(row.key, row.fields, recordId || undefined);
      n++;
    }
  }
  console.log(`- ${ticket}：工单行已更新，节点行 ${n} 条（events ${events.length}）`);
}
console.log('\n回填完成。');
