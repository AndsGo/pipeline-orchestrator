// 接入新项目向导（8 步 → 1 命令）：校验 → 写 PIPELINE_PROJECTS → 提示后续动作。
//   npx tsx scripts/add-project.ts                                       # 交互式
//   npx tsx scripts/add-project.ts --alias foo --repo D:/work/foo --prefix FO [--gitlab 组/foo] [--jenkins job] [--wiki 节点token] [--dry]
//
// GitLab 映射已收敛为一处（PIPELINE_PROJECTS[].gitlab 直供看板链接），本向导不碰 GITLAB_REPO_MAP。
// --dry 只打印将写入的 PIPELINE_PROJECTS 行（其中无凭据），不动 .env。
// 真写入前先备份整个 .env 到 backups/（.gitignore 已排除），并只改这一行——其余字节原样保留。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { projectsJsonWith, readEnvVar, upsertEnvVar, validateNewProject, type NewProject } from '../src/onboarding.js';
import { loadProjects } from '../src/projects.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const root = path.resolve(here, '..');
const envFile = path.join(root, '.env');

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dry = argv.includes('--dry');

if (!fs.existsSync(envFile)) {
  console.error(`.env 不存在（${envFile}）。先按 README 建好基础配置再接项目。`);
  process.exit(1);
}
const envText = fs.readFileSync(envFile, 'utf-8');
const projectsJson = readEnvVar(envText, 'PIPELINE_PROJECTS');
if (!projectsJson) {
  console.error('未找到 PIPELINE_PROJECTS。旧的单项目配置请先跑 npx tsx scripts/project-migrate.ts 迁移。');
  process.exit(1);
}
let existing;
try {
  existing = loadProjects({ PIPELINE_PROJECTS: projectsJson } as NodeJS.ProcessEnv);
} catch {
  existing = [];
}
if (!existing.length) {
  console.error('PIPELINE_PROJECTS 解析不出任何项目——先修好现有配置再接新的（可跑 doctor 定位）。');
  process.exit(1);
}
console.log(`现有项目：${existing.map((p) => `${p.alias}（${p.prefix}-）`).join('、')}\n`);

async function collect(): Promise<NewProject> {
  const fromFlags: NewProject = {
    alias: flag('alias') ?? '',
    repo: flag('repo') ?? '',
    prefix: flag('prefix') ?? '',
    gitlab: flag('gitlab'),
    jenkins: flag('jenkins'),
    wikiArchive: flag('wiki'),
  };
  if (fromFlags.alias && fromFlags.repo && fromFlags.prefix) return fromFlags;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, cur?: string): Promise<string> => cur ?? (await rl.question(q)).trim();
  const c: NewProject = {
    alias: await ask('项目别名（群里指代用，如 foo）：', fromFlags.alias || undefined),
    repo: await ask('本地仓库路径（如 D:/work/foo）：', fromFlags.repo || undefined),
    prefix: await ask('工单号前缀（1-6 个字母，如 FO → 工单号 FO-001）：', fromFlags.prefix || undefined),
    gitlab: (await ask('GitLab 项目路径（组/项目，可回车跳过——跳过则看板无工件链接）：', fromFlags.gitlab)) || undefined,
    jenkins: (await ask('Jenkins 任务名（可回车跳过——跳过则该项目工单不走 CI 阶段）：', fromFlags.jenkins)) || undefined,
    wikiArchive: (await ask('wiki 归档节点 token（可回车跳过——跳过则交付文档只发群不归档）：', fromFlags.wikiArchive)) || undefined,
  };
  rl.close();
  return c;
}

const cand = await collect();
const errs = validateNewProject(existing, cand);
// 文件系统检查放脚本层：纯逻辑层不碰盘
if (cand.repo && !fs.existsSync(cand.repo)) errs.push(`仓库路径不存在：${cand.repo}`);
else if (cand.repo && !fs.existsSync(path.join(cand.repo, '.git'))) errs.push(`${cand.repo} 不是 git 仓库（缺 .git）`);
if (errs.length) {
  console.error(`\n校验未通过：\n${errs.map((e) => `  ✗ ${e}`).join('\n')}`);
  process.exit(1);
}
if (cand.repo && !fs.existsSync(path.join(cand.repo, 'CLAUDE.md'))) {
  console.log('⚠ 该仓库没有 CLAUDE.md——阶段会话会缺少项目规范约束，建议补一份。');
}

const nextJson = projectsJsonWith(projectsJson, cand);
if (dry) {
  console.log(`\n[--dry] 将把 PIPELINE_PROJECTS 更新为：\n${nextJson}\n（未写入）`);
  process.exit(0);
}

// 备份整个 .env（含凭据，进 backups/ 不进 git），再精确改一行
const backupDir = path.join(root, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `env-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
fs.copyFileSync(envFile, backup);
fs.writeFileSync(envFile, upsertEnvVar(envText, 'PIPELINE_PROJECTS', nextJson), 'utf-8');
console.log(`\n✅ 已写入 .env（备份：${path.relative(root, backup)}）`);
console.log(`\n项目 ${cand.alias}（${cand.prefix.toUpperCase()}-）接入完成。后续三步：`);
console.log('  1. 重启 daemon 生效：.\\scripts\\start-daemon.ps1 -Stop; .\\scripts\\start-daemon.ps1');
console.log('  2. 体检：npx tsx scripts/doctor.ts');
console.log(`  3. 铺业务地基（强烈建议）：npx tsx scripts/system-map.ts --rebuild ${cand.alias} && --publish ${cand.alias}，`);
console.log('     并在目标仓库手写一页 docs/pipeline/PROJECT-BRIEF.md（之后 compound 自动增量维护）。');
