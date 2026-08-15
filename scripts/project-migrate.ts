// 项目维度迁移：给三张表补"项目/适用范围"字段，并回填存量工单与知识条目的项目归属。
// 用法: npx tsx scripts/project-migrate.ts   （幂等，可重复跑）
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bitableCfgFromEnv } from '../src/bitable/client.js';
import { KB_SCOPES } from '../src/bitable/schema.js';
import { listTickets } from '../src/events.js';
import { loadProjects, projectOfTicket } from '../src/projects.js';
import { readSnapshot } from '../src/ticket.js';

const cfg = bitableCfgFromEnv();
const { FEISHU_APP_ID, FEISHU_APP_SECRET } = process.env;
if (!cfg || !FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('缺少 BITABLE_* / FEISHU_* 配置');
  process.exit(1);
}
const c = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const projects = loadProjects();

/** 幂等加字段 */
async function ensureField(tableId: string, name: string, type: number, property?: Record<string, unknown>): Promise<void> {
  const res = (await c.bitable.appTableField.list({
    path: { app_token: cfg!.appToken, table_id: tableId },
    params: { page_size: 100 },
  })) as { data?: { items?: Array<{ field_name?: string }> } };
  if ((res?.data?.items ?? []).some((f) => f.field_name === name)) {
    console.log(`- ${tableId} 已有「${name}」`);
    return;
  }
  await c.bitable.appTableField.create({
    path: { app_token: cfg!.appToken, table_id: tableId },
    data: { field_name: name, type, ...(property ? { property } : {}) } as never,
  });
  console.log(`+ ${tableId} 已加「${name}」`);
}

await ensureField(cfg.ticketTableId, '项目', 1);
await ensureField(cfg.nodeTableId, '项目', 1);
if (cfg.kbTableId) {
  await ensureField(cfg.kbTableId, '项目', 1);
  await ensureField(cfg.kbTableId, '适用范围', 3, { options: KB_SCOPES.map((n) => ({ name: n })) });
}

/** 回填工单快照里的项目归属（按工单号前缀推断） */
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
for (const t of listTickets()) {
  const st = readSnapshot(t);
  if (!st || st.project) continue;
  const p = projectOfTicket(projects, t) ?? projects[0];
  fs.writeFileSync(path.join(DATA, `${t}.json`), JSON.stringify({ ...st, project: p.alias }, null, 2), 'utf-8');
  console.log(`+ ${t} 归属 → ${p.alias}`);
}

/** 回填表里已有记录的项目列 */
async function backfillColumn(tableId: string, resolve: (fields: Record<string, unknown>) => string | null): Promise<void> {
  const res = (await c.bitable.appTableRecord.list({
    path: { app_token: cfg!.appToken, table_id: tableId },
    params: { page_size: 200 },
  })) as { data?: { items?: Array<{ record_id?: string; fields?: Record<string, unknown> }> } };
  const rows = res?.data?.items ?? [];
  let n = 0;
  for (const r of rows) {
    if (!r.record_id || r.fields?.['项目']) continue;
    const alias = resolve(r.fields ?? {});
    if (!alias) continue;
    await c.bitable.appTableRecord.update({
      path: { app_token: cfg!.appToken, table_id: tableId, record_id: r.record_id },
      data: { fields: { 项目: alias } as never },
    });
    n++;
  }
  console.log(`  ${tableId} 回填 ${n} 行`);
}

const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => String((x as { text?: string }).text ?? x)).join('') : '';
const byTicket = (f: Record<string, unknown>): string | null => {
  const t = textOf(f['工单号']) || textOf(f['来源工单']);
  return t ? (projectOfTicket(projects, t) ?? projects[0]).alias : null;
};

console.log('回填表内记录：');
await backfillColumn(cfg.ticketTableId, byTicket);
await backfillColumn(cfg.nodeTableId, byTicket);
if (cfg.kbTableId) await backfillColumn(cfg.kbTableId, byTicket);
console.log('\n迁移完成。');
