// 一次性补字段：给历史工单快照补上真实分支名（state.branch）。
//   npx tsx scripts/branch-migrate.ts [--dry] [工单号...]
//
// 由来（2026-08-25）：看板的「分支」列此前按 `feat/<工单号>` 拼名字，而实际约定是
// `feat/<工单号>-<slug>`（feat/LS-012-org-call-monitor），拼出来的分支从未存在过。
// 修好的代码只对新工单生效——本脚本从 git 认领历史工单的真名（现存分支优先，
// 分支已随 MR 合并被删的从合并提交标题里恢复）。补完跑 bitable-backfill.ts 刷看板。
import fs from 'node:fs';
import path from 'node:path';
import { detectTicketBranch } from '../src/implementProgress.js';
import { listTickets } from '../src/events.js';
import { readSnapshot } from '../src/ticket.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const dataDir = path.resolve(here, '../data');
const dry = process.argv.includes('--dry');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const tickets = only.length ? only : listTickets();

let done = 0;
let missing = 0;
for (const ticket of tickets) {
  const state = readSnapshot(ticket);
  if (!state) continue;
  if (state.branch) {
    console.log(`- ${ticket}：已有 ${state.branch}，跳过`);
    continue;
  }
  const branch = detectTicketBranch(state.repo, ticket) ?? detectTicketBranch(state.mainRepo ?? state.repo, ticket);
  if (!branch) {
    console.log(`- ${ticket}：git 里查不到（分支已删且无合并提交记录），留空`);
    missing++;
    continue;
  }
  if (dry) {
    console.log(`- ${ticket}：将写入 ${branch}`);
    done++;
    continue;
  }
  const file = path.join(dataDir, `${ticket}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  raw.branch = branch;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  console.log(`- ${ticket}：已写入 ${branch}`);
  done++;
}
console.log(`\n${dry ? '预演' : '完成'}：${done} 条${missing ? `，${missing} 条查不到` : ''}`);
console.log('接着跑 npx tsx scripts/bitable-backfill.ts 把看板刷新。');
