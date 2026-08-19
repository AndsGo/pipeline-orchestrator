// 一次性只读探针：验证应用能否读群消息（引用父消息 / 合并转发子消息）。
// 用法：npx tsx scripts/msg-probe.ts   （自行加载 .env，不回显任何密钥值）
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 手动加载 .env（scripts 由 shell 直跑，没有 daemon 启动脚本的 env 注入）
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHAT_ID } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_CHAT_ID) {
  console.error('缺 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
  process.exit(1);
}
const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

const clip = (s: unknown, n = 80): string => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** SDK 对 4xx 是抛 AxiosError 而不是返回 code——统一剥出飞书错误码 */
function feishuErr(e: unknown): string {
  const data = (e as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  return data?.code ? `code=${data.code} msg=${data.msg}` : (e as Error).message;
}

// ① 列最近消息：这一步就是权限试金石（需要 im:message.group_msg scope）
interface MsgItem {
  message_id?: string;
  msg_type?: string;
  parent_id?: string;
  body?: { content?: string };
  create_time?: string;
}
let list: { data?: { items?: MsgItem[] } };
try {
  list = (await client.im.message.list({
    params: {
      container_id_type: 'chat',
      container_id: FEISHU_CHAT_ID,
      sort_type: 'ByCreateTimeDesc',
      page_size: 20,
    },
  })) as typeof list;
} catch (e) {
  console.log(`❌ 消息列表拉取失败：${feishuErr(e)}`);
  console.log('   → 缺权限时去开发者后台给应用加 scope「im:message.group_msg（获取群组中所有消息）」并发布版本，再跑本脚本验证。');
  process.exit(0);
}
const items = list.data?.items ?? [];
console.log(`✅ 能读群消息（最近 ${items.length} 条）：`);
for (const it of items) {
  console.log(
    `- ${new Date(Number(it.create_time)).toISOString()} [${it.msg_type}]${it.parent_id ? ' (有引用 parent_id)' : ''} ${clip(it.body?.content)}`,
  );
}

// ② 找 merge_forward，试拉子消息
const mf = items.find((it) => it.msg_type === 'merge_forward');
if (!mf?.message_id) {
  console.log('（最近 20 条里没有 merge_forward 消息，跳过子消息探测）');
  process.exit(0);
}
let detail: { data?: { items?: Array<{ msg_type?: string; body?: { content?: string } }> } };
try {
  detail = (await client.im.message.get({ path: { message_id: mf.message_id } })) as typeof detail;
} catch (e) {
  console.log(`❌ merge_forward 子消息拉取失败：${feishuErr(e)}`);
  process.exit(0);
}
const subs = detail.data?.items ?? [];
console.log(`✅ merge_forward 可展开，共 ${subs.length} 条（含父消息）：`);
for (const s of subs) console.log(`  - [${s.msg_type}] ${clip(s.body?.content, 100)}`);
