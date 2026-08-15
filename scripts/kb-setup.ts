// 扩建：给已有看板加「交付文档」字段与「知识」表，并在知识库里建两个归档父节点。
// 用法: npx tsx scripts/kb-setup.ts        （幂等，可重复跑）
import * as lark from '@larksuiteoapi/node-sdk';
import { KB_FIELDS, KB_TABLE } from '../src/bitable/schema.js';
import { ensureWikiFolder } from '../src/feishu/docs.js';
import { loadProjects } from '../src/projects.js';

const { FEISHU_APP_ID, FEISHU_APP_SECRET, BITABLE_APP_TOKEN, BITABLE_TICKET_TABLE_ID, WIKI_SPACE_ID } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !BITABLE_APP_TOKEN || !BITABLE_TICKET_TABLE_ID) {
  console.error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / BITABLE_APP_TOKEN / BITABLE_TICKET_TABLE_ID');
  process.exit(1);
}
const c = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const out: string[] = [];

// 1) 工单表补「交付文档」字段
const fields = (await c.bitable.appTableField.list({
  path: { app_token: BITABLE_APP_TOKEN, table_id: BITABLE_TICKET_TABLE_ID },
  params: { page_size: 100 },
})) as { data?: { items?: Array<{ field_name?: string }> } };
const names = (fields?.data?.items ?? []).map((f) => f.field_name);
if (names.includes('交付文档')) {
  console.log('- 工单表已有「交付文档」字段');
} else {
  await c.bitable.appTableField.create({
    path: { app_token: BITABLE_APP_TOKEN, table_id: BITABLE_TICKET_TABLE_ID },
    data: { field_name: '交付文档', type: 15 },
  });
  console.log('+ 工单表已加「交付文档」字段');
}

// 2) 建「知识」表
const tables = (await c.bitable.appTable.list({ path: { app_token: BITABLE_APP_TOKEN }, params: { page_size: 100 } })) as {
  data?: { items?: Array<{ table_id?: string; name?: string }> };
};
const existing = (tables?.data?.items ?? []).find((t) => t.name === KB_TABLE);
if (existing?.table_id) {
  console.log(`- 知识表已存在：${existing.table_id}`);
  out.push(`BITABLE_KB_TABLE_ID=${existing.table_id}`);
} else {
  const res = (await c.bitable.appTable.create({
    path: { app_token: BITABLE_APP_TOKEN },
    data: { table: { name: KB_TABLE, fields: KB_FIELDS as never } },
  })) as { data?: { table_id?: string } };
  console.log(`+ 已建知识表：${res?.data?.table_id}`);
  out.push(`BITABLE_KB_TABLE_ID=${res?.data?.table_id}`);
}

// 3) 知识库：一个空间共用，两个分类目录下按项目开子节点
if (WIKI_SPACE_ID) {
  const projects = loadProjects();
  const perProject: Record<string, { wikiArchive?: string; wikiKnowledge?: string }> = {};
  try {
    const archiveRoot = await ensureWikiFolder(c, WIKI_SPACE_ID, '需求档案');
    const knowledgeRoot = await ensureWikiFolder(c, WIKI_SPACE_ID, '工程知识');
    console.log(`= 分类目录：需求档案 ${archiveRoot} / 工程知识 ${knowledgeRoot}`);
    out.push(`WIKI_ARCHIVE_NODE=${archiveRoot}`, `WIKI_KNOWLEDGE_NODE=${knowledgeRoot}`);
    for (const p of projects) {
      const a = await ensureWikiFolder(c, WIKI_SPACE_ID, p.alias, archiveRoot);
      const k = await ensureWikiFolder(c, WIKI_SPACE_ID, p.alias, knowledgeRoot);
      perProject[p.alias] = { wikiArchive: a, wikiKnowledge: k };
      console.log(`+ 项目 ${p.alias}：需求档案/${p.alias} = ${a}，工程知识/${p.alias} = ${k}`);
    }
    console.log('\n把各项目的节点填进 PIPELINE_PROJECTS：');
    console.log(JSON.stringify(perProject, null, 2));
  } catch (e) {
    console.log(`! 知识库节点处理失败：${(e as Error).message.slice(0, 160)}`);
  }
} else {
  console.log('- 未设置 WIKI_SPACE_ID，跳过知识库节点（交付文档仍会生成云文档）');
}

if (out.length) {
  console.log('\n把下面几行写进 .env：');
  for (const l of out) console.log(l);
}
