// 实测 Markdown → 飞书云文档投递链路（转换 + 分批插入 + 授权 + 看板回填）
// 用法: npx tsx scripts/doc-probe.ts <markdown 文件> [工单号]
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import { setDeliveryDocLink } from '../src/bitable/sync.js';
import { moveDocToWiki, publishMarkdownDoc } from '../src/feishu/docs.js';

const [file, ticket] = process.argv.slice(2);
if (!file) {
  console.error('用法: npx tsx scripts/doc-probe.ts <markdown 文件> [工单号]');
  process.exit(1);
}
const c = new lark.Client({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET! });
const md = fs.readFileSync(file, 'utf-8');
const title = ticket ? `${ticket} 交付文档` : '交付文档投递实测';

const r = await publishMarkdownDoc(c, title, md, process.env.FEISHU_OWNER_OPEN_ID);
console.log(`文档已生成：${r.url}`);
console.log(`  插入块数：${r.blocks}${r.truncated ? '（过长已截断）' : ''}`);

let wikiUrl: string | null = null;
if (process.env.WIKI_SPACE_ID) {
  wikiUrl = await moveDocToWiki(c, process.env.WIKI_SPACE_ID, r.documentId, process.env.WIKI_ARCHIVE_NODE);
  console.log(`  知识库归档：${wikiUrl ?? '失败（见上方告警）'}`);
}
if (ticket) {
  await setDeliveryDocLink(ticket, r.url, wikiUrl);
  console.log('  看板「交付文档」字段已回填');
}
