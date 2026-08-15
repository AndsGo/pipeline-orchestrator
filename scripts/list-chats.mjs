// 列出机器人所在的群及 chat_id：FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx node scripts/list-chats.mjs
import * as lark from '@larksuiteoapi/node-sdk';

const { FEISHU_APP_ID, FEISHU_APP_SECRET } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}
const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const res = await client.im.chat.list({ params: { page_size: 50 } });
for (const c of res?.data?.items ?? []) {
  console.log(`${c.chat_id}  ${c.name ?? '(未命名)'}`);
}
