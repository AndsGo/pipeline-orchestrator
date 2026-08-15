// 建看板：创建多维表格 + 工单表 + 节点表，并授权使用者。
// 用法: npx tsx scripts/bitable-setup.ts [看板名称]
// 完成后把打印的三行配置写进 .env
import * as lark from '@larksuiteoapi/node-sdk';
import { createBoard } from '../src/bitable/client.js';

const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OWNER_OPEN_ID, BITABLE_APP_TOKEN } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}
if (BITABLE_APP_TOKEN) {
  console.error(`已配置 BITABLE_APP_TOKEN=${BITABLE_APP_TOKEN}，如需重建请先从 .env 移除`);
  process.exit(1);
}

const name = process.argv[2] ?? '流水线看板';
const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const r = await createBoard(client, name, FEISHU_OWNER_OPEN_ID);

console.log(`\n看板已创建：${r.url}\n`);
console.log('把下面三行写进 .env：');
console.log(`BITABLE_APP_TOKEN=${r.appToken}`);
console.log(`BITABLE_TICKET_TABLE_ID=${r.ticketTableId}`);
console.log(`BITABLE_NODE_TABLE_ID=${r.nodeTableId}`);
if (!FEISHU_OWNER_OPEN_ID) {
  console.log('\n注意：未设置 FEISHU_OWNER_OPEN_ID，看板由机器人持有，你可能看不到——');
  console.log('设置该变量后重建，或在飞书里让机器人把链接分享给你。');
}
