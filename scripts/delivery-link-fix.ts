// 一次性修数：把看板「交付文档」字段里的 docx 直链更正为知识库链接。
//   npx tsx scripts/delivery-link-fix.ts [项目别名] [--dry]
//
// 由来（2026-08-25）：知识库搬迁是异步的，moveDocsToWiki 当时只返回 task_id，
// 而 moveDocToWiki 只认 wiki_token、拿不到就返回 null——于是历次交付文档
// **实际都归档成功了**，看板里回填的却是 docx 直链。业务人员在知识库里找文档，
// docx 直链既搜不到也看不出归属。产生这个错误的代码已修（见 a36b731），
// 本脚本只负责把历史数据补正。可重复运行。
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { listWikiChildren } from '../src/feishu/docs.js';
import { loadProjects } from '../src/projects.js';
import { setDeliveryDocLink } from '../src/bitable/sync.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
if (!process.env.PIPELINE_PROJECTS) {
  const envFile = path.resolve(here, '../.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].trim();
    }
  }
}

const dry = process.argv.includes('--dry');
const alias = process.argv.slice(2).find((a) => !a.startsWith('--'));
const projects = loadProjects();
const project = alias ? projects.find((p) => p.alias === alias) : projects[0];
const { FEISHU_APP_ID, FEISHU_APP_SECRET, WIKI_SPACE_ID, WIKI_ARCHIVE_NODE } = process.env;
const parent = project?.wikiArchive ?? WIKI_ARCHIVE_NODE;
if (!project || !FEISHU_APP_ID || !FEISHU_APP_SECRET || !WIKI_SPACE_ID || !parent) {
  console.error('需要项目配置 + FEISHU_APP_ID/SECRET + WIKI_SPACE_ID + 归档节点');
  process.exit(1);
}

const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

/**
 * 看板里是否真有这一行。patchTicket 找不到行时**静默返回**，与"更新成功"无法区分，
 * 所以先自己查一次，报告里如实区分两种结果。
 * 不能靠 data/bitable-index.json——那只是本地缓存（实测当前为空），真相在表里。
 */
const { BITABLE_APP_TOKEN, BITABLE_TICKET_TABLE_ID } = process.env;

/** 读一行的「交付文档」字段：既用于存在性判断，也用于写后回读校验 */
async function readDeliveryLink(ticket: string): Promise<{ exists: boolean; link?: string }> {
  if (!BITABLE_APP_TOKEN || !BITABLE_TICKET_TABLE_ID) return { exists: false };
  try {
    const res = (await client.bitable.appTableRecord.search({
      path: { app_token: BITABLE_APP_TOKEN, table_id: BITABLE_TICKET_TABLE_ID },
      data: { filter: { conjunction: 'and', conditions: [{ field_name: '工单号', operator: 'is', value: [ticket] }] } },
      params: { page_size: 1 },
    })) as { data?: { items?: Array<{ fields?: Record<string, unknown> }> } };
    const item = res?.data?.items?.[0];
    if (!item) return { exists: false };
    const f = item.fields?.['交付文档'] as { link?: string } | undefined;
    return { exists: true, link: f?.link };
  } catch (e) {
    console.warn(`  查 ${ticket} 看板行失败：${(e as Error).message}`);
    return { exists: false };
  }
}
const children = await listWikiChildren(client, WIKI_SPACE_ID, parent);
console.log(`项目 ${project.alias} 的归档节点下有 ${children.length} 个子节点\n`);

let fixed = 0;
let skipped = 0;
for (const n of children) {
  const ticket = /^(\S+)\s*交付文档$/.exec(n.title ?? '')?.[1];
  if (!ticket || !n.node_token) continue;
  const wikiUrl = `https://feishu.cn/wiki/${n.node_token}`;
  const docxUrl = n.obj_token ? `https://feishu.cn/docx/${n.obj_token}` : wikiUrl;
  const before = await readDeliveryLink(ticket);
  if (!before.exists) {
    console.log(`- ${ticket}：看板里没有这一行，跳过（避免静默无操作被当成已修）`);
    skipped++;
    continue;
  }
  if (dry) {
    console.log(`- ${ticket}：${before.link ?? '(空)'} → ${wikiUrl}`);
    fixed++;
    continue;
  }
  // setDeliveryDocLink 吞异常（对正常流程是对的：回填失败不该让已完成的工单显示为失败），
  // 所以这里必须回读校验——不然"已更正"只等于"已请求"
  await setDeliveryDocLink(ticket, docxUrl, wikiUrl);
  const after = await readDeliveryLink(ticket);
  if (after.link === wikiUrl) {
    console.log(`- ${ticket}：已更正并回读确认 → ${wikiUrl}`);
    fixed++;
  } else {
    console.log(`- ${ticket}：⚠ 写入后回读仍为 ${after.link ?? '(空)'}，未生效`);
    skipped++;
  }
}

console.log(`\n${dry ? '预演' : '完成'}：${fixed} 条${skipped ? `，跳过 ${skipped} 条` : ''}`);
