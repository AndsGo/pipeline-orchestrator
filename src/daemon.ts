// 常驻编排 daemon：单一飞书长连接 + 多工单并行 + 群内指令通道
// 启动：npm run daemon（需 FEISHU_* 与 PIPELINE_REPOS）
import {
  classifyCommand,
  describeCommand,
  helpText,
  isProjectSlashCommand,
  looksLikeCommand,
  needsConfirm,
  parseSlash,
  slashSanityIssue,
  TICKET_RE,
  type Command,
  type TicketContext,
} from './commands.js';
import { fetchGlossaryBrief, fetchKnowledgeBrief, initBitableSync } from './bitable/sync.js';
import { buildDashboard, renderDashboard, type TicketRow } from './dashboard.js';
import { computeMetrics, metricsDashItems, readAllSnapshots } from './metrics.js';
import { appendEvent, listTickets, readEvents, timeline, totalCost } from './events.js';
import { FeishuPort, feishuConfigFromEnv, type IncomingMessage } from './feishu/port.js';
import { appendFeedback, appendRequirementAmendment } from './feedback.js';
import { acquireLock, findOrphanClaude, releaseLock } from './lock.js';
import { clearPaused, setPaused } from './pause.js';
import { Semaphore } from './semaphore.js';
import {
  describeProjects,
  loadProjects,
  nextTicketId,
  projectOfTicket,
  resolveProject,
  type Project,
} from './projects.js';
import { loadTicket, peekTicketRepo, readSnapshot, saveTicket } from './ticket.js';
import { PLUGIN_DIR } from './config.js';
import path from 'node:path';
import { writeAdhocRecord } from './adhocLog.js';
import { composeFollowupPrompt, describeLastRun, readLastRun, saveLastRun } from './followup.js';
import { runClaudeText } from './runner.js';
import { describeSlashTarget, resolveSlashTarget } from './slashTarget.js';
import { runTicket, scheduleRewind } from './ticketRunner.js';
import { allocateWorkspace } from './workspace.js';

const projects = loadProjects();
if (!projects.length) {
  throw new Error('daemon 需要 PIPELINE_PROJECTS（或旧的 PIPELINE_REPOS），如 {"lakeghost":{"repo":"D:/work/lake_spirit","prefix":"LS"}}');
}
const cfg = {
  defaultProject: process.env.PIPELINE_DEFAULT_REPO ?? projects[0].alias,
  maxConcurrency: Number(process.env.PIPELINE_MAX_CONCURRENCY ?? 2),
};
const startedAt = Date.now();
const sem = new Semaphore(cfg.maxConcurrency);
const active = new Map<string, { mainRepo: string; workdir: string }>();
/** 单次执行的轻量台账：不建工单，但成本要看得见 */
const adhoc: Array<{ at: string; project: string; text: string; costUsd: number }> = [];
const log = (m: string) => console.log(`[daemon] ${new Date().toISOString()} ${m}`);

// 进程级兜底：SDK/axios 的网络错误曾以未处理 rejection 的形式击穿整个进程（2026-08-17 DNS 抖动实证）。
// rejection 记日志继续跑（多为网络瞬时故障）；uncaughtException 状态已不可信，退出交给看门狗拉起。
process.on('unhandledRejection', (reason) => {
  log(`未处理的 rejection（继续运行）：${String((reason as Error)?.message ?? reason).slice(0, 300)}`);
});
process.on('uncaughtException', (err) => {
  log(`未捕获异常，进程退出交由看门狗拉起：${err.message.slice(0, 300)}`);
  process.exit(1);
});

/** 已有工单的项目归属：优先快照里固化的，其次按工单号前缀推断 */
function projectOf(ticket: string): Project | null {
  const alias = readSnapshot(ticket)?.project;
  return (alias ? resolveProject(projects, alias) : null) ?? projectOfTicket(projects, ticket);
}

let port: FeishuPort;

/** 启动/恢复一个工单的 runner（非阻塞） */
async function startTicket(ticket: string, projectHint: string | undefined, requirement?: string): Promise<string> {
  // 工单号要当文件名与分支名用：非法字符必须在建任何文件之前拦住
  if (!TICKET_RE.test(ticket)) {
    return `工单号「${ticket}」不合法（需字母开头，只含字母数字-_）。直接写内容即可，不要带尖括号，例：/new LS-004 需求原文…`;
  }
  if (active.has(ticket)) return `${ticket} 已在运行中`;
  const project = resolveProject(projects, projectHint) ?? projectOf(ticket) ?? resolveProject(projects, cfg.defaultProject);
  if (!project) return `无法确定项目（可用：${describeProjects(projects)}）`;
  const mainRepo = project.repo;

  const lock = acquireLock(ticket);
  if (!lock.ok) return `${ticket} 被另一个实例持有（pid ${lock.holder.pid}）`;

  // 孤儿检测：daemon 崩过而 claude 子进程仍活着时，绝不能再开第二个会话改同一仓库
  const orphans = findOrphanClaude(ticket);
  if (orphans.length) {
    releaseLock(ticket);
    return `${ticket} 仍有存活的 claude 进程（pid ${orphans.map((o) => o.pid).join(', ')}），清理后再启动：taskkill /PID <pid> /T /F`;
  }

  // 已绑定工作目录的工单沿用原目录；否则按主仓库是否被占用决定是否开 worktree
  const bound = peekTicketRepo(ticket);
  const busy = [...active.values()].some((a) => a.mainRepo === mainRepo);
  let workdir: string;
  let isWorktree = false;
  try {
    if (bound) {
      workdir = bound;
      isWorktree = bound !== mainRepo;
    } else {
      const ws = allocateWorkspace(mainRepo, ticket, busy);
      workdir = ws.workdir;
      isWorktree = ws.isWorktree;
      if (ws.isWorktree) log(`${ticket} 使用隔离 worktree ${ws.workdir}（base ${ws.baseRef}）`);
    }
  } catch (e) {
    releaseLock(ticket);
    return `${ticket} 工作区分配失败：${(e as Error).message}`;
  }

  active.set(ticket, { mainRepo, workdir });
  clearPaused(ticket);
  log(`${ticket} 归属项目 ${project.alias}（仓库 ${project.repo}${project.jenkins ? `，CI ${project.jenkins}` : ''}）`);

  void (async () => {
    try {
      await runTicket({ repo: workdir, ticket, port, project, requirement, acquire: () => sem.acquire() });
      // 记录工作区归属，便于后续续跑与人工定位
      const st = loadTicket(workdir, ticket, 'clarify');
      saveTicket({ ...st, mainRepo, isWorktree, project: project.alias });
    } catch (e) {
      const msg = (e as Error).message;
      log(`${ticket} runner 异常：${msg}`);
      appendEvent({ ticket, type: 'error', summary: `runner 异常：${msg.slice(0, 200)}` });
      await port.notify(ticket, `编排器异常：${msg.slice(0, 300)}`);
    } finally {
      releaseLock(ticket);
      active.delete(ticket);
      log(`${ticket} runner 结束（在跑 ${active.size}，闸门 ${sem.inUse}/${cfg.maxConcurrency}）`);
    }
  })();

  return `${ticket} 已启动${isWorktree ? '（并行隔离工作区）' : ''}`;
}

async function handleCommand(c: Command, sender: string): Promise<void> {
  switch (c.kind) {
    case 'help':
      await port.notify('指令', helpText());
      return;
    case 'dashboard': {
      const rows: TicketRow[] = listTickets().map((t) => {
        const st = readSnapshot(t);
        const evs = readEvents(t);
        const closed = st?.runs.some((r) => r.stage === 'compound' && r.status === 'DONE');
        return {
          ticket: t,
          project: st?.project,
          stage: closed ? '已闭环' : (st?.cursor ?? '?'),
          state: active.has(t) ? '在跑' : st?.haltedReason ? '挂起' : closed ? '闭环' : '等人工',
          cost: totalCost(t) || (st?.runs.reduce((s, r) => s + r.costUsd, 0) ?? 0),
          waiting: st?.haltedReason
            ? `挂起：${st.haltedReason}`
            : port.pendingLabels(t).length
              ? `等回答：${port.pendingLabels(t).join('、')}`
              : evs.at(-1)?.summary,
        };
      });
      const d = buildDashboard(process.env, {
        startedAt,
        now: Date.now(),
        concurrency: { inUse: sem.inUse, max: cfg.maxConcurrency, waiting: sem.waiting },
        activeTickets: [...active.keys()],
        pendingCards: port.pendingLabels().length,
        boardEnabled: boardOn,
        adhoc: { count: adhoc.length, cost: adhoc.reduce((a, x) => a + x.costUsd, 0) },
      }, rows, metricsDashItems(computeMetrics(readAllSnapshots())));
      const r = renderDashboard(d);
      await port.sendDashboard(r.config, r.runtime, r.tickets);
      return;
    }
    case 'list': {
      const rows = listTickets().map((t) => {
        const st = (() => {
          try {
            const repo = peekTicketRepo(t);
            return repo ? loadTicket(repo, t, 'clarify') : null;
          } catch {
            return null;
          }
        })();
        const mark = active.has(t) ? '🟢在跑' : st?.haltedReason ? '⛔挂起' : '⏹️空闲';
        return `${mark} ${t} @${st?.cursor ?? '?'}　$${totalCost(t).toFixed(2)}`;
      });
      await port.notify('工单', rows.length ? rows.join('\n') : '暂无工单');
      return;
    }
    case 'status': {
      const t = c.ticket ?? [...active.keys()][0] ?? listTickets().at(-1);
      if (!t) {
        await port.notify('状态', '还没有工单');
        return;
      }
      const repo = peekTicketRepo(t);
      const st = repo ? loadTicket(repo, t, 'clarify') : null;
      const extra = [
        `**通道：** ${st?.lane ?? '?'}　**在跑：** ${active.has(t) ? '是' : '否'}`,
        `**成本：** $${totalCost(t).toFixed(2)}　**回环：** review ${st?.reviewFixRounds ?? 0} / 验收 ${st?.acceptanceFixRounds ?? 0}`,
        st?.haltedReason ? `**挂起原因：** ${st.haltedReason}` : '',
        st?.isWorktree ? `**工作区：** ${st.repo}（隔离）` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await port.sendStatus(t, st?.cursor ?? '未知', extra, timeline(t, 20));
      return;
    }
    case 'pause':
      setPaused(c.ticket, sender);
      appendEvent({ ticket: c.ticket, type: 'pause', summary: `收到暂停指令（by ${sender}）` });
      await port.notify(c.ticket, '已登记暂停：当前阶段跑完即停（不会打断进行中的会话）');
      return;
    case 'resume': {
      clearPaused(c.ticket);
      // 挂起工单的「继续」= 人已处理挂起原因。不清标记的话重进即再挂，人陷入死循环
      const halted = readSnapshot(c.ticket);
      if (halted?.haltedReason) saveTicket({ ...halted, haltedReason: undefined });
      appendEvent({ ticket: c.ticket, type: 'resume', summary: `收到继续指令（by ${sender}）` });
      const repo = peekTicketRepo(c.ticket);
      await port.notify(c.ticket, await startTicket(c.ticket, repo ?? undefined));
      return;
    }
    case 'note': {
      const repo = peekTicketRepo(c.ticket);
      if (!repo) {
        await port.notify(c.ticket, '工单不存在');
        return;
      }
      appendFeedback(repo, c.ticket, '群内补充说明', c.text, sender);
      appendEvent({ ticket: c.ticket, type: 'human.message', summary: `补充说明：${c.text.slice(0, 80)}` });
      // 闭环工单的反馈没有任何后续阶段会读——不提示的话，「请你处理下」会无声地掉进死信（LS-006 实测）
      const snap = readSnapshot(c.ticket);
      const closed = snap?.runs.some((r) => (r.stage === 'compound' || r.stage === 'fast') && r.status === 'DONE');
      await port.notify(
        c.ticket,
        closed
          ? '已记录，但该工单已闭环，本条备注**不会被自动处理**。要改动或修问题请发 /new 新建工单（可在描述里引用本单）'
          : '已记入工单反馈，下一个阶段会读到（不回退）',
      );
      return;
    }
    case 'amend': {
      const repo = peekTicketRepo(c.ticket);
      if (!repo) {
        await port.notify(c.ticket, '工单不存在');
        return;
      }
      appendRequirementAmendment(repo, c.ticket, c.text, sender);
      const fb = appendFeedback(repo, c.ticket, '需求变更', c.text, sender);
      scheduleRewind(repo, c.ticket, 'clarify', '需求变更', fb);
      appendEvent({ ticket: c.ticket, type: 'amend', summary: `需求变更：${c.text.slice(0, 80)}` });
      await port.notify(
        c.ticket,
        active.has(c.ticket)
          ? '需求变更已记录：当前阶段跑完后自动回到澄清重跑'
          : `需求变更已记录。${await startTicket(c.ticket, repo)}`,
      );
      return;
    }
    case 'rewind': {
      const repo = peekTicketRepo(c.ticket);
      if (!repo) {
        await port.notify(c.ticket, '工单不存在');
        return;
      }
      const fb = c.reason ? appendFeedback(repo, c.ticket, `回退到 ${c.stage}`, c.reason, sender) : undefined;
      scheduleRewind(repo, c.ticket, c.stage, c.reason ?? '人工回退', fb);
      appendEvent({ ticket: c.ticket, type: 'rewind', stage: c.stage, summary: `登记回退到 ${c.stage}` });
      await port.notify(
        c.ticket,
        active.has(c.ticket)
          ? `已登记回退到 ${c.stage}：当前阶段跑完后生效`
          : `已登记回退到 ${c.stage}。${await startTicket(c.ticket, repo)}`,
      );
      return;
    }
    case 'run': {
      // 单次执行：低预算、不建工单、不进看板。工具里有 Bash——这不是只读通道，能跑测试也能跑部署脚本
      const project = resolveProject(projects, c.project) ?? resolveProject(projects, cfg.defaultProject);
      if (!project) {
        await port.notify('执行', `无法确定项目（可用：${describeProjects(projects)}）`);
        return;
      }
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
        if (!(await port.confirmCommand('执行', describeSlashTarget(target, project.alias)))) {
          log(`/run 已取消：/${target.name}`);
          await port.notify('执行', '已取消，没有任何改动');
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
        if (!(await port.confirmCommand('执行', what))) {
          log('/run 已取消（自然语言副作用指令）');
          await port.notify('执行', '已取消，没有任何改动');
          return;
        }
        slashRisks = ['自然语言判定的对外副作用'];
        log('  已确认，开始执行');
      }
      await port.notify('执行', `在 ${project.alias} 上执行：${c.text.slice(0, 80)}…`);
      // 命中相关经验/术语就带上（无关时为空串，简单问题不受噪音干扰）；斜杠指令不能前置任何文字，否则展不开
      const kbBrief = isSlashCmd ? '' : await fetchKnowledgeBrief(c.text, project.alias);
      const glBrief = isSlashCmd ? '' : await fetchGlossaryBrief(c.text, project.alias);
      // 条目行以「- **」开头；此前用 行数-3 推算，恒少报一条（1 头 + N 条 + 1 空行）——日志不许撒谎，哪怕小事
      if (kbBrief) log(`  注入知识提示 ${kbBrief.split('\n').filter((l) => l.startsWith('- **')).length} 条`);
      if (glBrief) log(`  注入术语 ${glBrief.split('\n').filter((l) => l.startsWith('- 「')).length} 条`);
      const brief = [glBrief, kbBrief].filter(Boolean).join('\n');
      await execAdhoc(project, c.text, `${brief ? `${brief}\n---\n` : ''}${c.text}`, slashRisks, 0);
      return;
    }
    case 'followup':
      await runFollowup(c.text);
      return;
    case 'new': {
      // 项目来源优先级：显式指定 > 工单号前缀 > 唯一项目 > 问人（绝不猜）
      let project =
        resolveProject(projects, c.repo) ?? (c.ticket ? projectOfTicket(projects, c.ticket) : null) ??
        (projects.length === 1 ? projects[0] : null);
      if (!project) {
        const pick = await port.chooseOption(
          '新工单',
          `这个需求属于哪个项目？\n> ${c.requirement.slice(0, 100)}`,
          projects.map((p) => `${p.alias}（${p.prefix}-）`),
        );
        project = projects.find((p) => pick.startsWith(p.alias)) ?? null;
        if (!project) {
          await port.notify('新工单', '未选择项目，已取消');
          return;
        }
      }
      const ticket = c.ticket ?? nextTicketId(project, listTickets());
      await port.notify(ticket, await startTicket(ticket, project.alias, c.requirement));
      return;
    }
    case 'unknown': {
      // 落空兜底：这句可能是在回复上一次 /run 的收尾问题（实测被判成 answer 后因无待答卡石沉大海）。
      // 以斜杠开头的不算——那是命令格式打错了，不是在回话
      const last = c.text.trim().startsWith('/') ? null : readLastRun();
      if (last) {
        const CONT = '是，接着办';
        const pick = await port.chooseOption(
          '执行',
          `现在没有待回答的卡片，这句我也没听懂：\n> ${c.text.slice(0, 120)}\n\n你是不是在回复刚才的执行结果 ${describeLastRun(last)}？`,
          [CONT, '不是，忽略这句'],
        );
        if (pick === CONT) {
          await runFollowup(c.text);
          return;
        }
        await port.notify('指令', '好，这句已忽略。要下指令可用斜杠命令（/help 看用法）。');
        return;
      }
      await port.notify('指令', `没听懂「${c.text.slice(0, 60)}」。\n${helpText()}`);
      return;
    }
  }
}

/**
 * 单次执行的公共执行体（/run 与续聊共用）：跑会话 → 落盘留痕 → 发结果 → 更新续聊指针。
 * commandText 是这一轮的用户原话（留痕与记账用），corePrompt 是发给模型的正文（可能带知识摘要或续聊上下文）。
 * 返回是否已向群里交付结果：resume 尝试在会话启动阶段就失败时返回 false 且不打扰群（由调用方降级重试）。
 */
async function execAdhoc(
  project: Project,
  commandText: string,
  corePrompt: string,
  slashRisks: string[],
  chain: number,
  opts?: { resumeSessionId?: string; origin?: string },
): Promise<boolean> {
  const release = await sem.acquire();
  const t0 = Date.now();
  // 输出语言必须钉死：实测出现过整段韩语回复直接进业务群。
  // 收尾问题必须编号带选项：这是续聊协议的另一半——答复要能对得上号。
  // 无人值守声明：实测会话被工具白名单拦下后，向群里喊「请在权限提示中点击允许」——那个提示不存在
  const prompt = `${corePrompt}\n\n（结果会原样发到中文业务群，请全程用中文回复；结尾若有需要用户决定的问题，请逐条编号并给出可选项。你运行在无人值守环境：没有权限提示可点，工具不可用就是不可用——做不到的事直接说做不到，并给出替代路径）`;
  try {
    const r = await runClaudeText({
      cwd: project.repo,
      prompt,
      tools: 'Read,Grep,Glob,Bash,Skill,WebFetch',
      model: process.env.PIPELINE_RUN_MODEL ?? 'sonnet',
      maxTurns: 40,
      budgetUsd: Number(process.env.PIPELINE_RUN_BUDGET ?? 3),
      pluginDir: PLUGIN_DIR,
      resumeSessionId: opts?.resumeSessionId,
    });
    const at = new Date().toISOString();
    adhoc.push({ at, project: project.alias, text: commandText.slice(0, 200), costUsd: r.costUsd });
    const seconds = Math.round((Date.now() - t0) / 1000);
    // 输出必须落盘：只记字符数的话，事后想查"到底跑没跑成"只能去翻别人的聊天窗口
    const file = writeAdhocRecord({
      at,
      project: project.alias,
      command: commandText,
      prompt,
      output: r.text,
      costUsd: r.costUsd,
      turns: r.turns,
      seconds,
      isError: r.isError,
    });
    const tail = `$${r.costUsd.toFixed(2)} · ${r.turns} 轮 · ${seconds}s`;
    log(
      `/run ${r.isError ? '会话异常' : '完成'}：${tail}，输出 ${r.text.length} 字符${file ? ` → ${path.basename(file)}` : ''}`,
    );
    log(`  输出首行：${r.text.split('\n').find((l) => l.trim())?.slice(0, 160) ?? '(空)'}`);
    if (r.isError) {
      // 会话中途出错时 result 装的是报错文案。按"执行结果"发出去，等于把失败伪装成成功。
      // 续聊指针也不更新：从一段报错文案"接着办"没有意义
      await port.sendResult(
        `执行未完成 · ${project.alias}`,
        [
          `⚠️ **这次执行没有正常跑完**，下面是会话返回的错误：`,
          '',
          r.text,
          ...(slashRisks.length
            ? ['', `**这条指令有对外副作用（${slashRisks.join('、')}），中断位置未知——远端状态请自行确认后再重试。**`]
            : []),
        ].join('\n'),
        `${tail} · 失败，未产出结果`,
      );
    } else {
      saveLastRun({
        at,
        project: project.alias,
        command: commandText,
        output: r.text,
        chain,
        sessionId: r.sessionId,
        origin: opts?.origin ?? commandText,
      });
      await port.sendResult(
        `执行结果 · ${project.alias}`,
        r.text,
        `${tail} · 单次执行，不建工单不入看板（要改代码走 /new；结尾有问题的话，直接回复或 \`/re 答复\` 可继续这次任务）`,
      );
    }
    return true;
  } catch (e) {
    // resume 的启动期失败（id 失效 → CLI 纯文本报错，走不到 JSON 解析）：不打扰群，交给调用方降级。
    // 已经跑起来再失败的（isError）不在此列——那时可能已产生副作用，绝不能静默重跑
    if (opts?.resumeSessionId) {
      log(`续聊 resume 失败（将降级为拼接模式）：${(e as Error).message.slice(0, 160)}`);
      return false;
    }
    log(`/run 失败：${(e as Error).message.slice(0, 200)}`);
    await port.notify('执行', `失败：${(e as Error).message.slice(0, 300)}`);
    return false;
  } finally {
    release();
  }
}

/** 续聊：把答复接回上一次单次执行——优先 --resume 真续会话，失败降级拼接（见 followup.ts 头注） */
async function runFollowup(reply: string): Promise<void> {
  const last = readLastRun();
  if (!last) {
    await port.notify('执行', '最近 24 小时内没有可继续的单次执行记录。直接用 /run 重新说清要做的事即可。');
    return;
  }
  const project = resolveProject(projects, last.project) ?? resolveProject(projects, cfg.defaultProject);
  if (!project) {
    await port.notify('执行', `无法确定项目（可用：${describeProjects(projects)}）`);
    return;
  }
  const origin = last.origin ?? last.command;
  log(`续聊（第 ${last.chain + 1} 轮${last.sessionId ? '，resume' : '，拼接'}）on ${project.alias}: ${reply.slice(0, 80)}`);
  await port.notify('执行', `继续上次执行 ${describeLastRun(last)}，已带上你的答复…`);
  if (last.sessionId) {
    // 真续会话：完整历史在会话里，正文只需要答复本身
    if (await execAdhoc(project, reply, reply, [], last.chain + 1, { resumeSessionId: last.sessionId, origin })) return;
    log('  resume 未成功，改用拼接模式重试');
  }
  await execAdhoc(project, reply, composeFollowupPrompt(last, reply), [], last.chain + 1, { origin });
}

async function onMessage(m: IncomingMessage): Promise<void> {
  log(`收到消息 by ${m.sender}${m.mentioned ? '（@我）' : ''}: ${m.text.slice(0, 80)}`);
  const slash = parseSlash(m.text);
  if (!slash) {
    // 有待确认卡片时，先看这句话是不是在回答它（明确表决/选项才拦截，不劫持指令）
    const ans = port.tryAnswerByText(m.text);
    if (ans.status === 'resolved') {
      await port.notify('回答', `已记录 ${ans.label} → ${ans.answer}${ans.note ? `（补充：${ans.note}）` : ''}`);
      return;
    }
    if (ans.status === 'resolved-batch') {
      await port.notify(
        '回答',
        `已记录 ${ans.labels.length} 项 → ${ans.answer}（${ans.labels.join('、')}）` +
          (ans.skipped.length ? `\n未匹配、仍待回答：${ans.skipped.join('、')}` : ''),
      );
      return;
    }
    if (ans.status === 'ambiguous') {
      await port.notify('回答', ans.detail);
      return;
    }
  }
  let cmd: Command;
  if (slash) {
    cmd = slash;
    // A 档语义体检：只在明显冲突时拦（如验收阶段用 /amend 报缺陷），保住"斜杠即明确"的效率
    const issue = slashSanityIssue(cmd, ticketContexts().find((c) => c.ticket === (cmd as { ticket?: string }).ticket));
    if (issue) {
      const t = (cmd as { ticket: string }).ticket;
      const pick = await port.chooseOption(t, `${issue}\n\n你想要哪一个？`, ['记为说明（不回退）', '确实要改需求（回退到澄清）']);
      if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: t, text: (cmd as { text: string }).text };
      else if (!pick.startsWith('确实')) {
        await port.notify(t, '已取消');
        return;
      }
    }
  } else {
    // @了机器人 → 一定回应；没 @ → 只在像指令时才花钱分类，避免打扰群聊
    if (!m.mentioned && !looksLikeCommand(m.text)) return;
    const contexts = ticketContexts();
    const { command, confidence, error, missingTicket } = await classifyCommand(m.text, contexts);
    cmd = command;
    // 识别服务炸了 ≠ 没听懂：前者回"重发一次"，后者才是"我不明白你的意思"
    if (error) {
      log(`意图识别失败（已重试）：${error}`);
      await port.notify(
        '指令',
        `识别服务异常，这条消息没能读懂：${error.slice(0, 120)}\n请重发一次；或直接用斜杠指令（\`/run\`、\`/new\`、\`/note LS-00X 内容\`）绕过识别。`,
      );
      return;
    }
    const namedTicket = (cmd as { ticket?: string }).ticket;
    log(`意图识别：${cmd.kind}（把握 ${(confidence * 100).toFixed(0)}%）${namedTicket ? ` → ${namedTicket}` : ''}`);

    // 听懂了但缺工单号：问一句，别把人家的缺陷描述丢进 unknown
    if (missingTicket) {
      const cands = contexts.map((c) => c.ticket).slice(0, 3);
      log(`意图识别：${missingTicket.kind} 但未指明工单，转人工选择`);
      const DIAG = '先诊断一次（不建工单）';
      const pick = await port.chooseOption(
        '指令',
        `我听懂了这是一条${missingTicket.kind === 'amend' ? '需求修改' : '说明/缺陷'}，但没说是哪个工单：\n> ${m.text.slice(0, 120)}\n\n怎么处理？`,
        [DIAG, ...cands],
      );
      if (pick === DIAG) cmd = { kind: 'run', text: m.text };
      else if (cands.includes(pick)) cmd = { kind: missingTicket.kind, ticket: pick, text: missingTicket.text };
      else {
        await port.notify('指令', '已取消');
        return;
      }
    }

    // 闭环工单不能改需求：这类"新需求描述"应该开新单，而不是把已交付的工单退回澄清
    if (cmd.kind === 'amend') {
      const am = cmd; // 固化窄化后的引用：cmd 后面会被重新赋值，闭包里读不到窄化类型
      const issue = slashSanityIssue(am, contexts.find((c) => c.ticket === am.ticket));
      if (issue) {
        const pick = await port.chooseOption(am.ticket, `${issue}\n\n> ${am.text.slice(0, 120)}\n\n你想怎么处理？`, [
          '开一个新工单',
          '记为说明（不回退）',
          '取消',
        ]);
        if (pick.startsWith('开一个新工单')) cmd = { kind: 'new', requirement: am.text };
        else if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: am.ticket, text: am.text };
        else {
          await port.notify(am.ticket, '已取消');
          return;
        }
      }
    }

    // 分类为"回答卡片" → 走待答项路由（自由文本也接受）
    if (cmd.kind === 'answer') {
      const c = cmd;
      const composed = c.target ? `${c.target} ${c.text}` : c.text;
      const r = port.tryAnswerByText(composed, true);
      if (await reportAnswer(r)) return;
      cmd = { kind: 'note', ticket: c.ticket ?? '', text: c.text }; // 卡片已过期 → 退化为说明
      if (!cmd.ticket) cmd = { kind: 'unknown', text: m.text };
    }

    // 低置信不猜：给候选让人点（比"没听懂"友好，也是最省事的纠错）
    if (cmd.kind !== 'unknown' && confidence < 0.6) {
      const t = (cmd as { ticket?: string }).ticket ?? [...active.keys()][0] ?? '指令';
      const pick = await port.chooseOption(
        t,
        `我不太确定你的意思（识别为 **${cmd.kind}**，把握 ${(confidence * 100).toFixed(0)}%）：\n> ${m.text.slice(0, 120)}`,
        [`按 ${cmd.kind} 执行`, '记为说明（/note）', '取消'],
      );
      if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: t, text: m.text };
      else if (pick === '取消') {
        await port.notify(t, '已取消');
        return;
      }
    }

    if (cmd.kind === 'unknown') {
      // 没听懂但有待答卡片 → 当作自由文本答案（人的话不该被丢掉）
      if (await reportAnswer(port.tryAnswerByText(m.text, true))) return;
      if (!m.mentioned) return; // 没 @ 又没听懂：安静退出
    }
  }

  // 分级确认：改变流程走向的一律先问，卡片上写清"我理解为什么、会导致什么"
  if (needsConfirm(cmd)) {
    const t = (cmd as { ticket: string }).ticket;
    if (!(await port.confirmCommand(t, describeCommand(cmd)))) {
      await port.notify(t, '已取消');
      return;
    }
  }

  try {
    await handleCommand(cmd, m.sender);
  } catch (e) {
    log(`指令处理失败：${(e as Error).message}`);
    await port.notify('指令', `处理失败：${(e as Error).message}`);
  }
}

/** 统一回执待答项路由结果；返回是否已处理完毕 */
async function reportAnswer(r: ReturnType<FeishuPort['tryAnswerByText']>): Promise<boolean> {
  if (r.status === 'resolved') {
    await port.notify('回答', `已记录 ${r.label} → ${r.answer}${r.note ? `（补充：${r.note}）` : ''}`);
    return true;
  }
  if (r.status === 'resolved-batch') {
    await port.notify(
      '回答',
      `已记录 ${r.labels.length} 项 → ${r.answer}（${r.labels.join('、')}）` +
        (r.skipped.length ? `\n未匹配、仍待回答：${r.skipped.join('、')}` : ''),
    );
    return true;
  }
  if (r.status === 'ambiguous') {
    await port.notify('回答', r.detail);
    return true;
  }
  return false;
}

/** 汇总各工单现场，供意图识别判断"这句话在当前上下文里是什么意思" */
function ticketContexts(): TicketContext[] {
  return listTickets().map((t) => {
    const st = readSnapshot(t);
    return {
      ticket: t,
      stage: st?.cursor ?? '?',
      runState: active.has(t) ? '在跑' : st?.haltedReason ? '挂起' : '等人工',
      pending: port.pendingLabels(t),
      halted: st?.haltedReason,
    };
  });
}

// 看板投影（可选）：事件 → 多维表格。isActive 让「运行状态」字段能区分在跑与等人工
const boardOn = initBitableSync((t) => active.has(t), log);
log(boardOn ? '看板投影已启用（多维表格）' : '看板投影未配置（缺 BITABLE_*，跳过）');

port = await FeishuPort.create(feishuConfigFromEnv(), (m) => void onMessage(m));
log(`daemon 就绪：并发上限 ${cfg.maxConcurrency}，项目 ${describeProjects(projects)}（默认 ${cfg.defaultProject}）`);
await port.notify('流水线', `编排器已上线。并发上限 ${cfg.maxConcurrency}。\n${helpText()}`);
