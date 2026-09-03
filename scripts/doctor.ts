// 流水线体检：依赖 / 配置 / 连通性 / 真实推理，一眼看清哪里断了。
//   npx tsx scripts/doctor.ts               # 全量（含一次 ~$0.01 的真实推理探测）
//   npx tsx scripts/doctor.ts --no-infer    # 跳过推理探测（零成本）
// 只读不修；输出永不包含凭据值（只报有/无与长度）。任何 ❌ 都会以退出码 1 结束。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableBoard } from '../src/bitable/client.js';
import { projectCfgFromEnv } from '../src/bitable/sync.js';
import { PLUGIN_DIR, RUNNER_SETTINGS } from '../src/config.js';
import { pipelineDocsIgnored } from '../src/onboarding.js';
import { PROFILE_FILE } from '../src/profile.js';
import { ciJobFor, loadProjects } from '../src/projects.js';
import { runClaudeText } from '../src/runner.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const root = path.resolve(here, '..');

// 手跑的终端拿不到 daemon 启动脚本注入的环境，自己装载 .env（UTF8，同 start-daemon.ps1 的坑）
if (!process.env.PIPELINE_PROJECTS && fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].trim();
  }
}

type Grade = '✅' | '⚠️' | '❌';
const rows: Array<{ grade: Grade; name: string; detail: string }> = [];
const add = (grade: Grade, name: string, detail: string): void => {
  rows.push({ grade, name, detail });
  console.log(`${grade} ${name} — ${detail}`);
};
const tryExec = (cmd: string): string | null => {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
  } catch {
    return null;
  }
};
const fetchOk = async (url: string, init?: RequestInit): Promise<Response | null> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  } catch {
    return null;
  }
};

console.log('== 依赖 ==');
const nodeMajor = Number(process.version.slice(1).split('.')[0]);
add(nodeMajor >= 20 ? '✅' : '❌', 'node', `${process.version}${nodeMajor >= 20 ? '' : '（需要 ≥20）'}`);
for (const [name, cmd, why] of [
  ['git', 'git --version', '没有它什么都干不了'],
  ['bash', 'bash -c "echo ok"', '阶段会话经 bash 调起 claude'],
  ['claude CLI', 'claude --version', '流水线的执行引擎'],
] as const) {
  const v = tryExec(cmd);
  add(v ? '✅' : '❌', name, v ? v.split('\n')[0] : `不可用（${why}）`);
}
const glab = tryExec('glab --version');
add(glab ? '✅' : '⚠️', 'glab', glab ? glab.split('\n')[0] : '未安装——会话无法自动建 MR（人工在 GitLab 建则不受影响）');

console.log('\n== 编排器自身 ==');
// manifest 的标准位置是 .claude-plugin/plugin.json（首版 doctor 查错了根目录，实测被自己抓包）
add(fs.existsSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')) ? '✅' : '❌', 'plugin', PLUGIN_DIR);
try {
  JSON.parse(fs.readFileSync(RUNNER_SETTINGS, 'utf-8'));
  add('✅', 'runner settings', RUNNER_SETTINGS);
} catch (e) {
  // -p 模式下损坏的 settings 会被静默忽略 → enabledPlugins 失效 → 双流控串线（2026-08-18 事故）
  add('❌', 'runner settings', `${RUNNER_SETTINGS} 缺失或非法 JSON：${(e as Error).message.slice(0, 80)}——静默失效会复发双流控事故`);
}

console.log('\n== 项目配置 ==');
const projects = loadProjects();
if (!projects.length) add('❌', 'PIPELINE_PROJECTS', '解析不出任何项目');
const cfg = projectCfgFromEnv();
for (const p of projects) {
  const probs: string[] = [];
  if (!fs.existsSync(p.repo)) probs.push('仓库路径不存在');
  else if (!fs.existsSync(path.join(p.repo, '.git'))) probs.push('不是 git 仓库');
  else if (!fs.existsSync(path.join(p.repo, 'CLAUDE.md'))) probs.push('无 CLAUDE.md（建议补）');
  if (fs.existsSync(p.repo) && !fs.existsSync(path.join(p.repo, PROFILE_FILE))) probs.push(`无 ${PROFILE_FILE}（流程约定：测试环境/验收人/上线方式，缺省按无测试环境、不设上线走）`);
  // 实测 odoo-product（2026-09-02）：.gitignore 整个屏蔽 docs，PRD/评审/原型/知识沉淀全部不入库
  if (fs.existsSync(path.join(p.repo, '.git')) && pipelineDocsIgnored(p.repo)) {
    probs.push('.gitignore 屏蔽了 docs/pipeline（流水线工件不入库：MR 里看不到 PRD/评审，换 worktree 即丢；把 docs 改成 docs/* 并加 !docs/pipeline/）');
  }
  if (!cfg.repoToProject[p.repo]) probs.push('无 GitLab 映射（看板工件链接将为空）');
  // CI 任务按项目解析：全局 JENKINS_JOB 只在单项目部署时兜底（多项目下借全局 job 会跑错项目的构建）
  const ciJob = ciJobFor(p);
  if (ciJob && (!process.env.JENKINS_USER || !process.env.JENKINS_TOKEN)) probs.push('配了 CI 任务但缺 JENKINS_USER/TOKEN');
  const dup = projects.filter((q) => q.prefix.toLowerCase() === p.prefix.toLowerCase()).length > 1;
  if (dup) probs.push(`前缀 ${p.prefix} 与其他项目冲突（路由会把工单派错仓库）`);
  const fatal = probs.some((s) => s.includes('不存在') || s.includes('不是 git') || s.includes('冲突') || s.includes('缺 JENKINS'));
  add(probs.length ? (fatal ? '❌' : '⚠️') : '✅', `项目 ${p.alias}（${p.prefix}-）`, probs.join('；') || `${p.repo}${ciJob ? ` · CI ${ciJob}${p.jenkins ? '' : '（单项目全局兜底）'}` : ' · 无 CI（工单直达验收；要走 CI 请给该项目配 jenkins 字段）'}`);
}

console.log('\n== 连通性 ==');
const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHAT_ID, GITLAB_URL, JENKINS_URL, JENKINS_USER, JENKINS_TOKEN, WIKI_SPACE_ID } =
  process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_CHAT_ID) {
  add('❌', '飞书', '缺 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
} else {
  const r = await fetchOk('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const body = r ? ((await r.json().catch(() => null)) as { code?: number; msg?: string } | null) : null;
  add(body?.code === 0 ? '✅' : '❌', '飞书', body?.code === 0 ? 'tenant token 获取成功' : `失败：${body?.msg ?? '网络不通/超时'}`);
}
const board = BitableBoard.fromEnv();
if (!board) add('⚠️', '多维表格', '未配置 BITABLE_*（看板/知识/术语不可用，流水线本身可跑）');
else {
  try {
    add('✅', '多维表格', `知识表可读（${(await board.listKnowledge()).length} 条）`);
  } catch (e) {
    add('❌', '多维表格', `读取失败：${(e as Error).message.slice(0, 100)}`);
  }
}
if (!GITLAB_URL) add('⚠️', 'GitLab', '未配置 GITLAB_URL（看板无工件链接）');
else {
  const r = await fetchOk(GITLAB_URL);
  add(r ? '✅' : '❌', 'GitLab', r ? `${GITLAB_URL} 可达（HTTP ${r.status}）` : `${GITLAB_URL} 不可达`);
}
if (!JENKINS_URL) add('⚠️', 'Jenkins', '未配置（所有项目都不走 CI 阶段）');
else {
  const auth = JENKINS_USER && JENKINS_TOKEN ? { Authorization: `Basic ${Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString('base64')}` } : undefined;
  const r = await fetchOk(`${JENKINS_URL.replace(/\/$/, '')}/api/json`, { headers: auth });
  add(
    r && r.status < 400 ? '✅' : '❌',
    'Jenkins',
    r ? (r.status < 400 ? '认证可用' : `HTTP ${r.status}（401/403 = 凭据不对）`) : '不可达/超时',
  );
}
if (!WIKI_SPACE_ID) add('⚠️', 'wiki 知识库', '未配置 WIKI_SPACE_ID（交付文档不归档）');
else if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
  try {
    const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
    const res = (await client.wiki.spaceNode.list({ path: { space_id: WIKI_SPACE_ID }, params: { page_size: 1 } })) as {
      code?: number;
    };
    add(res?.code === 0 || res?.code === undefined ? '✅' : '❌', 'wiki 知识库', `space ${WIKI_SPACE_ID} 可读`);
  } catch (e) {
    add('❌', 'wiki 知识库', `space ${WIKI_SPACE_ID} 读取失败：${(e as Error).message.slice(0, 100)}`);
  }
}

console.log('\n== daemon ==');
const pidFile = path.join(root, 'data', 'daemon.pid');
if (!fs.existsSync(pidFile)) add('⚠️', 'daemon', '未在运行（无 pid 文件）');
else {
  const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
  // EPERM = 进程活着但本 shell 无权限（看门狗提权拉起的 daemon 就是这样，2026-09-02 实测被误报成「已死」），
  // 与 lock.ts 的 pidAlive 同一口径；只有 ESRCH 才是真死
  let state: 'alive' | 'elevated' | 'dead' = 'dead';
  try {
    process.kill(pid, 0);
    state = 'alive';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') state = 'elevated';
  }
  add(
    state === 'dead' ? '❌' : state === 'elevated' ? '⚠️' : '✅',
    'daemon',
    state === 'alive'
      ? `运行中（pid ${pid}）`
      : state === 'elevated'
        ? `运行中但为提权进程（pid ${pid}）——本 shell 杀不动它；重启用 start-daemon.ps1 -Stop 写停止信号，它空闲时自退、看门狗拉起`
        : `pid 文件指向已死进程 ${pid}——删掉 data/daemon.pid 再启动`,
  );
}
add(tryExec('schtasks /query /tn PipelineDaemonWatchdog') ? '✅' : '⚠️', '看门狗计划任务', tryExec('schtasks /query /tn PipelineDaemonWatchdog') ? 'PipelineDaemonWatchdog 已注册' : '未注册（daemon 崩溃后不会自动拉起）');

if (!process.argv.includes('--no-infer')) {
  console.log('\n== 真实推理 ==');
  const cwd = projects.find((p) => fs.existsSync(p.repo))?.repo ?? root;
  try {
    const r = await runClaudeText({ cwd, prompt: '只回复两个字：正常', tools: 'Read', model: 'haiku', maxTurns: 3, budgetUsd: 0.1 });
    add(!r.isError && r.text.length > 0 ? '✅' : '❌', '推理探测', `${r.isError ? '会话报错' : `回复 ${r.text.slice(0, 20)}`}（$${r.costUsd.toFixed(3)}）`);
  } catch (e) {
    add('❌', '推理探测', (e as Error).message.slice(0, 120));
  }
}

const bad = rows.filter((r) => r.grade === '❌').length;
const warn = rows.filter((r) => r.grade === '⚠️').length;
console.log(`\n体检完成：${rows.length} 项，❌ ${bad} / ⚠️ ${warn}。${bad ? '先修 ❌ 再跑工单。' : warn ? '⚠️ 均为可选能力缺失，流水线可跑。' : '一切就绪。'}`);
process.exit(bad ? 1 : 0);
