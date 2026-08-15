// 知识表状态门迁移（一次性）：给已存在的知识表补「状态」单选字段，存量条目回填「生效」。
// 新表由 schema.ts 建出即含该字段，本脚本只服务状态门上线前建的表。
//   npx tsx scripts/kb-status-migrate.ts
import * as lark from '@larksuiteoapi/node-sdk';
import { KB_STATUSES } from '../src/bitable/schema.js';

const { FEISHU_APP_ID, FEISHU_APP_SECRET, BITABLE_APP_TOKEN, BITABLE_KB_TABLE_ID } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !BITABLE_APP_TOKEN || !BITABLE_KB_TABLE_ID) {
  console.error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / BITABLE_APP_TOKEN / BITABLE_KB_TABLE_ID');
  process.exit(1);
}

const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const path = { app_token: BITABLE_APP_TOKEN, table_id: BITABLE_KB_TABLE_ID };

// 1) 字段存在性
const fieldsRes = (await client.bitable.appTableField.list({ path, params: { page_size: 100 } })) as {
  data?: { items?: Array<{ field_name?: string }> };
};
const hasStatus = (fieldsRes?.data?.items ?? []).some((f) => f.field_name === '状态');
if (hasStatus) {
  console.log('「状态」字段已存在，跳过创建');
} else {
  await client.bitable.appTableField.create({
    path,
    data: { field_name: '状态', type: 3, property: { options: KB_STATUSES.map((o) => ({ name: o })) } } as never,
  });
  console.log(`已创建「状态」单选字段（${KB_STATUSES.join(' / ')}）`);
}

// 2) 存量条目回填「生效」——状态门上线前入库的条目已被实际使用过，不重新过审
const list = (await client.bitable.appTableRecord.list({ path, params: { page_size: 200 } })) as {
  data?: { items?: Array<{ record_id?: string; fields?: Record<string, unknown> }> };
};
let backfilled = 0;
for (const it of list?.data?.items ?? []) {
  if (!it.record_id || it.fields?.['状态']) continue;
  await client.bitable.appTableRecord.update({
    path: { ...path, record_id: it.record_id },
    data: { fields: { 状态: '生效' } as Record<string, never> },
  });
  backfilled++;
}
console.log(`存量条目回填完成：${backfilled} 条 → 生效（共 ${list?.data?.items?.length ?? 0} 条）`);
