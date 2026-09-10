import fs from 'node:fs';
import path from 'node:path';
import { claudeMdIgnored, pipelineDocsIgnored, projectsJsonWith, validateNewProject } from '../../onboarding.js';
import { ensureProfileTemplate } from '../../profile.js';
import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';
import { commitProjectsEnv, readProjectsEnv } from '../projectsEnv.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'addproject'>, _sender: string, chat?: ChatRef): Promise<void> {
  const { port, projects, log } = ctx;
  // 群内接入新项目（2026-08-31）：复用终端向导的全部校验与剥壳；写 .env 前整份备份进 backups/
  const cand = { alias: c.alias, repo: c.repo.replace(/\\/g, '/'), prefix: c.prefix, gitlab: c.gitlab, jenkins: c.jenkins, wikiArchive: c.wiki };
  const errs = validateNewProject(projects, cand);
  if (!fs.existsSync(cand.repo)) errs.push(`仓库路径不存在：${cand.repo}`);
  else if (!fs.existsSync(path.join(cand.repo, '.git'))) errs.push(`${cand.repo} 不是 git 仓库`);
  if (errs.length) {
    await port.notify('新项目', `校验未通过：\n${errs.map((e) => `✗ ${e}`).join('\n')}`, chat);
    return;
  }
  const { envText, current } = readProjectsEnv(ctx.envFile);
  if (!current) {
    await port.notify('新项目', '.env 里没有 PIPELINE_PROJECTS，请先在终端跑 scripts/project-migrate.ts', chat);
    return;
  }
  // 内存热加载：daemon 不重启即可路由新项目（看板工件链接的投影配置在下次重启后才更新）
  commitProjectsEnv(ctx, envText, projectsJsonWith(current, cand));
  const added = projects.find((p) => p.alias === c.alias);
  log(`群内接入新项目 ${c.alias}（${added?.prefix}-），现共 ${projects.length} 个项目`);
  await port.notify(
    '新项目',
    [
      `✅ 项目 **${c.alias}**（工单号 ${added?.prefix}-XXX）已接入，现在就能用（.env 已备份）。`,
      // 与终端向导对齐的提醒（首个群内接入 odoo-product 实测缺失，2026-08-31）
      ...(fs.existsSync(path.join(cand.repo, 'CLAUDE.md')) ? [] : ['⚠ 该仓库没有 CLAUDE.md——阶段会话将缺少项目规范约束，建议补一份。']),
      // 流程约定文件：没有就生成模板（有副作用，但只是一份 docs 文件），让人把测试环境/验收人/上线方式填进去
      ensureProfileTemplate(cand.repo, c.alias)
        ? '已生成 docs/pipeline/PIPELINE.md 模板：请填测试环境地址、验收人、上线方式，各阶段会话会读对应小节。不填 = 无测试环境、研发验收、不设上线环节。'
        : 'docs/pipeline/PIPELINE.md 已存在，流程按它走。',
      // 同一项目第二个坑（2026-09-02）：.gitignore 屏蔽 docs → 流水线工件全部不入库
      ...(pipelineDocsIgnored(cand.repo)
        ? ['⚠ 该仓库的 .gitignore 屏蔽了 docs/pipeline——PRD/评审/原型都不会入库，MR 里看不到、换 worktree 即丢。建议把 `docs` 改成 `docs/*` 并加一行 `!docs/pipeline/`。']
        : []),
      ...(claudeMdIgnored(cand.repo)
        ? ['⚠ 该仓库的 .gitignore 屏蔽了 CLAUDE.md——沉淀采纳的常识进不了 git，只停在本机。请从 .gitignore 删掉那一行。']
        : []),
      `仓库：${cand.repo}${added?.gitlab ? `\nGitLab：${added.gitlab}` : ''}${added?.jenkins ? `\nCI：${added.jenkins}` : '\nCI：未配（该项目工单直达验收；要走 CI 用 jenkins=任务名 重新执行本命令）'}`,
      '',
      '两个后续建议：',
      `1. 终端跑 \`npx tsx scripts/doctor.ts\` 做一次体检；`,
      `2. 铺业务地基（clarify 的洞察力来源）：\`npx tsx scripts/system-map.ts --rebuild ${c.alias}\` + 手写一页 PROJECT-BRIEF.md。`,
      '',
      '注：多维表格的工件链接对新项目将在下次 daemon 重启后生效。',
    ].join('\n'),
    chat,
  );
}
