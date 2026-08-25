// 能力地图维护：查新鲜度 / 全量重建 / 发布到飞书。
//   npx tsx scripts/system-map.ts --check [项目别名]      # 新鲜度报告（零成本，不调模型）
//   npx tsx scripts/system-map.ts --rebuild [项目别名]    # 会话全量重建（约 $3-6）
//   npx tsx scripts/system-map.ts --publish [项目别名]    # 把 index.md 推成飞书云文档并归档
//
// 分工：compound 每单增量维护（强制产物），本脚本负责全量重建与发布——
// 增量永远补不回已经漂移的部分，两者都要。建议每月或地图落后 30+ 提交时跑一次 --rebuild。
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { PLUGIN_DIR, STAGES } from '../src/config.js';
import { findWikiNodeByObjToken, publishMarkdownDoc, moveDocToWiki, updateMarkdownDoc } from '../src/feishu/docs.js';
import { loadProjects } from '../src/projects.js';
import { runClaudeText } from '../src/runner.js';
import { mapFreshness, systemMapIndex } from '../src/systemMap.js';

// 维护脚本是人在普通终端里手跑的，拿不到 daemon 启动脚本注入的那份环境。
// 必须显式 UTF8：.env 里的中文注释按 ANSI 读会吞换行、粘连下一行配置（与 start-daemon.ps1 同一个坑）。
if (!process.env.PIPELINE_PROJECTS) {
  const envFile = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '../.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].trim();
    }
  }
}

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--'))?.slice(2) ?? 'check';
const alias = args.find((a) => !a.startsWith('--'));

/** 已发布文档 id（按项目别名）：让每次发布覆盖同一篇而不是新建 */
const DOC_IDS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '../data/system-map-docs.json');
function readDocIds(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(DOC_IDS, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}
function writeDocIds(v: Record<string, string>): void {
  fs.writeFileSync(DOC_IDS, `${JSON.stringify(v, null, 2)}\n`, 'utf-8');
}

const projects = loadProjects();
const project = alias ? projects.find((p) => p.alias === alias) : projects[0];
if (!project) {
  console.error(`找不到项目${alias ? ` ${alias}` : ''}。已配置：${projects.map((p) => p.alias).join('、') || '（无）'}`);
  process.exit(1);
}
const repo = project.repo;
console.log(`项目 ${project.alias} → ${repo}\n`);

const fresh = mapFreshness(repo);
console.log(`新鲜度：${fresh.headline}`);
if (fresh.generatedAt) console.log(`地图生成于：${fresh.generatedAt}`);

if (mode === 'check') {
  if (fresh.exists && (fresh.commitsBehind ?? 0) >= 30) {
    console.log('\n落后已超过 30 个提交，建议跑 --rebuild 全量重建。');
  }
  process.exit(0);
}

if (mode === 'rebuild') {
  const cfg = STAGES.compound; // 与沉淀阶段同档：读全仓 + 写文档，不需要 implement 那种预算
  console.log('\n启动全量重建会话…');
  const { text, costUsd, turns, isError } = await runClaudeText({
    cwd: repo,
    prompt: '/pipeline-system-map rebuild',
    pluginDir: PLUGIN_DIR,
    tools: 'Read,Grep,Glob,Write,Edit,Bash',
    model: cfg.model,
    maxTurns: 120, // 重建要逐条核销路由与页面，比一次沉淀重
    budgetUsd: 12,
  });
  console.log(`\n${text}\n`);
  console.log(`${isError ? '⚠ 会话报错' : '完成'}：$${costUsd.toFixed(2)}，${turns} 轮`);
  if (isError) process.exit(1);
  const after = mapFreshness(repo);
  console.log(`重建后新鲜度：${after.headline}`);
  console.log('地图是仓库工件——记得在目标仓库提交 docs/pipeline/system-map/。');
  process.exit(0);
}

if (mode === 'publish') {
  const index = systemMapIndex(repo);
  if (!fs.existsSync(index)) {
    console.error('地图不存在，先跑 --rebuild');
    process.exit(1);
  }
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OWNER_OPEN_ID, WIKI_SPACE_ID, WIKI_ARCHIVE_NODE } = process.env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    console.error('未配置 FEISHU_APP_ID/FEISHU_APP_SECRET');
    process.exit(1);
  }
  // 能力页不单独发：飞书那份是给业务人员看的总览，细节留在仓库（一处真相，见 handoff-spec 跨工单工件一节）
  const body = [
    fs.readFileSync(index, 'utf-8'),
    '',
    '---',
    '',
    `> 本页由流水线自动生成于 ${new Date().toISOString()}，权威源是仓库 \`docs/pipeline/system-map\`。`,
    '> 各能力的详情页留在仓库里，未随本页发布。',
  ].join('\n');
  const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

  // 覆盖同一篇：业务人员只该有一个固定链接，每次新建会攒出一堆同名页。
  // 文档 id 存在 data/（gitignored、随看门狗每日备份）；文档被人删掉时退回新建。
  const known = readDocIds();
  const prev = known[project.alias];
  let doc: Awaited<ReturnType<typeof publishMarkdownDoc>> | null = null;
  if (prev) {
    try {
      doc = await updateMarkdownDoc(client, prev, body);
      console.log(`\n已更新原文档（${doc.blocks} 块）`);
    } catch (e) {
      console.warn(`原文档 ${prev} 更新失败（可能已被删除），改为新建：${(e as Error).message}`);
    }
  }
  if (!doc) {
    doc = await publishMarkdownDoc(client, `${project.alias} 能力地图`, body, FEISHU_OWNER_OPEN_ID);
    const wikiUrl = WIKI_SPACE_ID
      ? await moveDocToWiki(client, WIKI_SPACE_ID, doc.documentId, project.wikiArchive ?? WIKI_ARCHIVE_NODE)
      : null;
    known[project.alias] = doc.documentId;
    writeDocIds(known);
    console.log(`\n已发布：${wikiUrl ?? doc.url}`);
    process.exit(0);
  }
  // 对外给的是知识库链接：业务人员是在知识库里找文档的，docx 直链他们既搜不到也不知道归属
  const archived =
    WIKI_SPACE_ID && (project.wikiArchive ?? WIKI_ARCHIVE_NODE)
      ? await findWikiNodeByObjToken(client, WIKI_SPACE_ID, (project.wikiArchive ?? WIKI_ARCHIVE_NODE)!, doc.documentId)
      : null;
  console.log(`\n链接不变：${archived ?? doc.url}`);
  process.exit(0);
}

console.error(`未知模式 --${mode}；用法见文件头部`);
process.exit(1);
