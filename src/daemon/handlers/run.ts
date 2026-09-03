import { fetchGlossaryBrief, fetchKnowledgeBrief } from '../../bitable/sync.js';
import { isProjectSlashCommand } from '../../commands.js';
import { PLUGIN_DIR } from '../../config.js';
import { describeProjects, mentionedProject, resolveProject } from '../../projects.js';
import { describeSlashTarget, resolveSlashTarget } from '../../slashTarget.js';
import { readSticky, writeSticky } from '../../sticky.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'run'>, _sender: string, chat?: string): Promise<void> {
  const { port, projects, cfg, log } = ctx;
  // 单次执行：低预算、不建工单、不进看板。工具里有 Bash——这不是只读通道，能跑测试也能跑部署脚本
  let project = resolveProject(projects, c.project);
  // 多项目路由（2026-08-26「navo」实测）：消息里指名项目优先于默认回落；疑似拼错先问、绝不猜
  if (!project && projects.length > 1) {
    const m = mentionedProject(projects, c.text);
    if (m?.exact) project = m.project;
    else if (m) {
      const others = projects.filter((p) => p.alias !== m.project.alias).map((p) => p.alias);
      const pick = await port.chooseOption(
        '执行',
        `你是想在项目 **${m.project.alias}** 上执行吗（消息里的写法没完全对上项目名）？\n> ${c.text.slice(0, 120)}`,
        [`${m.project.alias}（推荐）`, ...others, '取消'],
        chat,
      );
      if (pick === '取消') {
        await port.notify('执行', '已取消', chat);
        return;
      }
      project = projects.find((p) => pick.startsWith(p.alias)) ?? null;
    }
  }
  // 群绑定：这个群就是这个项目（/bind）；再往后是项目粘性（本群最近明确指过的项目，见 sticky.ts）
  if (!project && chat) project = projects.find((p) => p.chatId === chat) ?? null;
  if (!project && chat) project = readSticky(chat, projects);
  project ??= resolveProject(projects, cfg.defaultProject);
  if (!project) {
    await port.notify('执行', `无法确定项目（可用：${describeProjects(projects)}）`, chat);
    return;
  }
  // 记粘性：绑定群不记（群即项目），未绑定群沿用这次的归属
  if (chat && !projects.some((p) => p.chatId === chat)) writeSticky(chat, project.alias);
  const isSlashCmd = isProjectSlashCommand(c.text);
  let slashRisks: string[] = []; // 执行失败时要据此提醒"远端状态未知"
  log(`/run on ${project.alias}${isSlashCmd ? '（斜杠指令）' : ''}: ${c.text.slice(0, 100)}`);
  // 斜杠指令是个黑盒（可能是只读检查，也可能往镜像仓库推 latest）：先解析清楚，再让人确认
  if (isSlashCmd) {
    const target = resolveSlashTarget(project.repo, c.text, PLUGIN_DIR);
    if (target.kind === 'unknown') {
      log(`/run 找不到 /${target.name}${target.suggestion ? `（最接近：/${target.suggestion}）` : ''}`);
      await port.notify(
        '执行',
        target.suggestion
          ? `${project.alias} 里没有 \`/${target.name}\`，你是不是想跑 \`/${target.suggestion}\`？`
          : `${project.alias} 里没有 \`/${target.name}\`。要问问题就直接写自然语言，不用加斜杠`,
      );
      return; // 不花钱让模型去"讨论"一个不存在的命令
    }
    slashRisks = target.risks ?? [];
    log(`  解析为 ${target.origin} ${target.file}${slashRisks.length ? `｜风险：${slashRisks.join('、')}` : ''}`);
    if (!(await port.confirmCommand('执行', describeSlashTarget(target, project.alias), chat))) {
      log(`/run 已取消：/${target.name}`);
      await port.notify('执行', '已取消，没有任何改动', chat);
      return;
    }
    log(`  已确认，开始执行 /${target.name}`); // 确认到完成之间可能几分钟，中间没日志会被误判为"点击没落地"
  } else if (c.sideEffect) {
    // 自然语言同样能触发部署（"帮我把镜像推一下"）：闸门认的是意图，不是斜杠语法。
    // 这里没法像斜杠指令那样列出具体命令——诚实地说明这一点，别假装知道会跑什么
    log(`/run 判定为有对外副作用，先确认：${c.text.slice(0, 80)}`);
    const what = [
      `即将在 **${project.alias}** 执行（自然语言指令）：`,
      '',
      `> ${c.text.slice(0, 300)}`,
      '',
      '⚠️ 我判断这件事**会影响本机之外的东西**（部署／推送／发布之类）。',
      '这不是预先写好的命令，**具体会跑什么由会话临场决定，我无法提前列出**。',
      '想要可预期的执行，请直接用 `/run /<指令名>`（那样卡片会列出确切命令）。',
      '',
      '_单次执行：有 Bash 权限、不建工单、不进流水线评审。取消不会有任何改动。_',
    ].join('\n');
    if (!(await port.confirmCommand('执行', what, chat))) {
      log('/run 已取消（自然语言副作用指令）');
      await port.notify('执行', '已取消，没有任何改动', chat);
      return;
    }
    slashRisks = ['自然语言判定的对外副作用'];
    log('  已确认，开始执行');
  }
  await port.notify('执行', `在 ${project.alias} 上执行：${c.text.slice(0, 80)}…`, chat);
  // 命中相关经验/术语就带上（无关时为空串，简单问题不受噪音干扰）；斜杠指令不能前置任何文字，否则展不开
  const kbBrief = isSlashCmd ? '' : await fetchKnowledgeBrief(c.text, project.alias);
  const glBrief = isSlashCmd ? '' : await fetchGlossaryBrief(c.text, project.alias);
  // 条目行以「- **」开头；此前用 行数-3 推算，恒少报一条（1 头 + N 条 + 1 空行）——日志不许撒谎，哪怕小事
  if (kbBrief) log(`  注入知识提示 ${kbBrief.split('\n').filter((l) => l.startsWith('- **')).length} 条`);
  if (glBrief) log(`  注入术语 ${glBrief.split('\n').filter((l) => l.startsWith('- 「')).length} 条`);
  const brief = [glBrief, kbBrief].filter(Boolean).join('\n');
  await ctx.execAdhoc(project, c.text, `${brief ? `${brief}\n---\n` : ''}${c.text}`, slashRisks, 0, { chat });
}
