// 只读探针：查知识库某节点下挂了哪些文档，用来核实「归档到底成没成」。
//   npx tsx scripts/wiki-probe.ts               # 列归档节点下的全部子节点
//   npx tsx scripts/wiki-probe.ts <document_id> # 另外判断该文档是否在其中
//
// 由来（2026-08-25）：moveDocsToWiki 搬迁是**异步**的，返回 task_id 而非 wiki_token，
// 而 moveDocToWiki 只认 wiki_token、拿不到就返回 null——调用方据此以为归档失败，
// 对外报的是 docx 链接。历次交付文档也走同一条路径，都要靠本探针才能确认真实去向。
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

if (!process.env.FEISHU_APP_ID) {
  const envFile = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '../.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].trim();
    }
  }
}

const { FEISHU_APP_ID, FEISHU_APP_SECRET, WIKI_SPACE_ID, WIKI_ARCHIVE_NODE } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !WIKI_SPACE_ID) {
  console.error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / WIKI_SPACE_ID');
  process.exit(1);
}
const wanted = process.argv[2];
const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

const res = (await client.wiki.spaceNode.list({
  path: { space_id: WIKI_SPACE_ID },
  params: { page_size: 50, ...(WIKI_ARCHIVE_NODE ? { parent_node_token: WIKI_ARCHIVE_NODE } : {}) },
})) as { data?: { items?: Array<{ title?: string; node_token?: string; obj_token?: string; obj_type?: string }> } };

const items = res?.data?.items ?? [];
console.log(`归档节点下共 ${items.length} 个子节点：\n`);
for (const n of items) {
  const mark = wanted && n.obj_token === wanted ? ' ←' : '';
  console.log(`  [${n.obj_type}] ${n.title}${mark}`);
  console.log(`      wiki: https://feishu.cn/wiki/${n.node_token}${mark}`);
}
if (wanted) {
  const hit = items.find((n) => n.obj_token === wanted);
  console.log(`\n文档 ${wanted}：${hit ? `已在知识库（${hit.title}）` : '不在该节点下'}`);
}
