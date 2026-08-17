// 在现有看板多维表格里创建「术语」表（一次性）。
//   npx tsx scripts/glossary-setup.ts
// 完成后把打印的 BITABLE_GLOSSARY_TABLE_ID 写进 .env。
import * as lark from '@larksuiteoapi/node-sdk';
import { GLOSSARY_FIELDS, GLOSSARY_TABLE } from '../src/bitable/schema.js';

const { FEISHU_APP_ID, FEISHU_APP_SECRET, BITABLE_APP_TOKEN, BITABLE_GLOSSARY_TABLE_ID } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !BITABLE_APP_TOKEN) {
  console.error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / BITABLE_APP_TOKEN');
  process.exit(1);
}
if (BITABLE_GLOSSARY_TABLE_ID) {
  console.error(`已配置 BITABLE_GLOSSARY_TABLE_ID=${BITABLE_GLOSSARY_TABLE_ID}，如需重建请先从 .env 移除`);
  process.exit(1);
}

const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const res = (await client.bitable.appTable.create({
  path: { app_token: BITABLE_APP_TOKEN },
  data: { table: { name: GLOSSARY_TABLE, fields: GLOSSARY_FIELDS as never } },
})) as { data?: { table_id?: string } };
const id = res?.data?.table_id;
if (!id) throw new Error('创建术语表失败');
console.log('术语表已创建。把下面一行写进 .env：');
console.log(`BITABLE_GLOSSARY_TABLE_ID=${id}`);
