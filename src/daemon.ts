// 常驻编排 daemon：单一飞书长连接 + 多工单并行 + 群内指令通道
// 启动：npm run daemon（需 FEISHU_* 与 PIPELINE_REPOS）
import {
  classifyCommand,
  describeCommand,
  helpText,
  looksLikeCommand,
  needsConfirm,
  parseSlash,
  slashSanityIssue,
  TICKET_RE,
  type Command,
  type TicketContext,
} from './commands.js';
import { initBitableSync } from './bitable/sync.js';
import { BitableBoard } from './bitable/client.js';
import { agingSummary, dueForAudit, readAuditStamp, writeAuditStamp } from './kbAudit.js';
import { lastHitByTitle } from './hits.js';
import { appendEvent, interruptedStage, listTickets, lostPendingCards, readEvents } from './events.js';
import { FeishuPort, feishuConfigFromEnv, type IncomingMessage } from './feishu/port.js';
import { acquireLock, findOrphanClaude, releaseLock } from './lock.js';
import { clearPaused } from './pause.js';
import { Semaphore } from './semaphore.js';
import { describeProjects, loadProjects, projectOfTicket, resolveProject, type Project } from './projects.js';
import { loadTicket, peekTicketRepo, readSnapshot, saveTicket } from './ticket.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { draftRequirementFromChat, execAdhoc, runFollowup } from './daemon/adhoc.js';
import type { DaemonContext } from './daemon/context.js';
import { dispatch } from './daemon/handlers/index.js';
import { runTicket } from './ticketRunner.js';
import { allocateWorkspace } from './workspace.js';

const projects = loadProjects();
if (!projects.length) {
  throw new Error('daemon 需要 PIPELINE_PROJECTS（或旧的 PIPELINE_REPOS），如 {"lakeghost":{"repo":"D:/work/lake_spirit","prefix":"LS"}}');
}
/** 主群 chat_id：综合入口，不允许 /bind 到单一项目 */
const MAIN_CHAT = feishuConfigFromEnv().chatId;
const cfg = {
  defaultProject: process.env.PIPELINE_DEFAULT_REPO ?? projects[0].alias,
  maxConcurrency: Number(process.env.PIPELINE_MAX_CONCURRENCY ?? 2),
};
const startedAt = Date.now();
const sem = new Semaphore(cfg.maxConcurrency);
const active = new Map<string, { mainRepo: string; workdir: string }>();
/** 单次执行的轻量台账：不建工单，但成本要看得见 */
const adhoc: DaemonContext['adhoc'] = [];
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

/** 启动/恢复一个工单的 runner（非阻塞）。intakeContext 只在首次建单时进 00-intake.md，续跑传了也没副作用 */
async function startTicket(ticket: string, projectHint: string | undefined, requirement?: string, intakeContext?: string): Promise<string> {
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
      await runTicket({ repo: workdir, ticket, port, project, requirement, intakeContext, acquire: () => sem.acquire() });
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

async function handleCommand(c: Command, sender: string, chat?: string): Promise<void> {
  // chat = 消息来源群：通用指令答复回到来源群；工单类通知不带它，由 routeChat 按项目绑定群路由
  await dispatch(ctx, c, sender, chat);
}

async function onMessage(m: IncomingMessage): Promise<void> {
  log(`收到消息 by ${m.sender}${m.mentioned ? '（@我）' : ''}: ${m.text.slice(0, 80)}`);
  const slash = parseSlash(m.text);
  if (!slash) {
    // 有待确认卡片时，先看这句话是不是在回答它（明确表决/选项才拦截，不劫持指令）
    const ans = port.tryAnswerByText(m.text);
    if (ans.status === 'resolved') {
      await port.notify('回答', `已记录 ${ans.label} → ${ans.answer}${ans.note ? `（补充：${ans.note}）` : ''}`, m.chatId);
      return;
    }
    if (ans.status === 'resolved-batch') {
      await port.notify(
        '回答',
        `已记录 ${ans.labels.length} 项 → ${ans.answer}（${ans.labels.join('、')}）` +
          (ans.skipped.length ? `\n未匹配、仍待回答：${ans.skipped.join('、')}` : ''),
        m.chatId,
      );
      return;
    }
    if (ans.status === 'ambiguous') {
      await port.notify('回答', ans.detail, m.chatId);
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
      const pick = await port.chooseOption(t, `${issue}\n\n你想要哪一个？`, ['记为说明（不回退）', '确实要改需求（回退到澄清）'], m.chatId);
      if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: t, text: (cmd as { text: string }).text };
      else if (!pick.startsWith('确实')) {
        await port.notify(t, '已取消', m.chatId);
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
        m.chatId,
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
        m.chatId,
      );
      if (pick === DIAG) cmd = { kind: 'run', text: m.text };
      else if (cands.includes(pick)) cmd = { kind: missingTicket.kind, ticket: pick, text: missingTicket.text };
      else {
        await port.notify('指令', '已取消', m.chatId);
        return;
      }
    }

    // 闭环工单不能改需求：这类"新需求描述"应该开新单，而不是把已交付的工单退回澄清
    if (cmd.kind === 'amend') {
      const am = cmd; // 固化窄化后的引用：cmd 后面会被重新赋值，闭包里读不到窄化类型
      const issue = slashSanityIssue(am, contexts.find((c) => c.ticket === am.ticket));
      if (issue) {
        const pick = await port.chooseOption(
          am.ticket,
          `${issue}\n\n> ${am.text.slice(0, 120)}\n\n你想怎么处理？`,
          ['开一个新工单', '记为说明（不回退）', '取消'],
          m.chatId,
        );
        if (pick.startsWith('开一个新工单')) cmd = { kind: 'new', requirement: am.text };
        else if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: am.ticket, text: am.text };
        else {
          await port.notify(am.ticket, '已取消', m.chatId);
          return;
        }
      }
    }

    // 分类为"回答卡片" → 走待答项路由（自由文本也接受）
    if (cmd.kind === 'answer') {
      const c = cmd;
      const composed = c.target ? `${c.target} ${c.text}` : c.text;
      const r = port.tryAnswerByText(composed, true);
      if (await reportAnswer(r, m.chatId)) return;
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
        m.chatId,
      );
      if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: t, text: m.text };
      else if (pick === '取消') {
        await port.notify(t, '已取消', m.chatId);
        return;
      }
    }

    if (cmd.kind === 'unknown') {
      // 没听懂但有待答卡片 → 当作自由文本答案（人的话不该被丢掉）
      if (await reportAnswer(port.tryAnswerByText(m.text, true), m.chatId)) return;
      if (!m.mentioned) return; // 没 @ 又没听懂：安静退出
    }
  }

  // 分级确认：改变流程走向的一律先问，卡片上写清"我理解为什么、会导致什么"
  if (needsConfirm(cmd)) {
    const t = (cmd as { ticket: string }).ticket;
    if (!(await port.confirmCommand(t, describeCommand(cmd), m.chatId))) {
      await port.notify(t, '已取消', m.chatId);
      return;
    }
  }

  try {
    await handleCommand(cmd, m.sender, m.chatId);
  } catch (e) {
    log(`指令处理失败：${(e as Error).message}`);
    await port.notify('指令', `处理失败：${(e as Error).message}`, m.chatId);
  }
}

/** 统一回执待答项路由结果；返回是否已处理完毕 */
async function reportAnswer(r: ReturnType<FeishuPort['tryAnswerByText']>, chat?: string): Promise<boolean> {
  if (r.status === 'resolved') {
    await port.notify('回答', `已记录 ${r.label} → ${r.answer}${r.note ? `（补充：${r.note}）` : ''}`, chat);
    return true;
  }
  if (r.status === 'resolved-batch') {
    await port.notify(
      '回答',
      `已记录 ${r.labels.length} 项 → ${r.answer}（${r.labels.join('、')}）` +
        (r.skipped.length ? `\n未匹配、仍待回答：${r.skipped.join('、')}` : ''),
      chat,
    );
    return true;
  }
  if (r.status === 'ambiguous') {
    await port.notify('回答', r.detail, chat);
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
// 工单生命周期通知按项目绑定群路由（/bind 设置）：工单号前缀 → 项目，或直接给项目别名
port.routeChat = (t) => (projectOfTicket(projects, t) ?? projects.find((p) => p.alias === t))?.chatId;
// 指令处理器只通过这份上下文拿状态（src/daemon/context.ts）。port 已就绪、到首个 await 之间无消息可达，此处装配无时序风险
const ctx: DaemonContext = {
  projects,
  cfg,
  MAIN_CHAT,
  port,
  log,
  active,
  sem,
  adhoc,
  startedAt,
  boardOn,
  envFile: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'),
  startTicket,
  execAdhoc: (project, commandText, corePrompt, slashRisks, chain, opts) => execAdhoc(ctx, project, commandText, corePrompt, slashRisks, chain, opts),
  runFollowup: (reply, chat) => runFollowup(ctx, reply, chat),
  draftRequirementFromChat: (project, last) => draftRequirementFromChat(ctx, project, last),
};
log(`daemon 就绪：并发上限 ${cfg.maxConcurrency}，项目 ${describeProjects(projects)}（默认 ${cfg.defaultProject}）`);
await port.notify('流水线', `编排器已上线。并发上限 ${cfg.maxConcurrency}。\n${helpText()}`);

// 中断巡检：上一个 daemon 死掉时正在跑的工单不会自我恢复，必须开机点名（LS-013 教训：静停 13 小时没人知道）。
// 刚启动时 active 必空，events 判据即事实
for (const t of listTickets()) {
  const evs = readEvents(t);
  const stage = interruptedStage(evs);
  if (stage) {
    log(`${t} 上次运行在 ${stage} 阶段被打断，已在群里提示恢复`);
    await port.notify(t, `⚠ 上次运行在 **${stage}** 阶段中途被打断（daemon 重启/崩溃），进度未丢失。发「继续 ${t}」或 /resume ${t} 恢复。`);
    continue;
  }
  // 姊妹盲区（OP-001 实测）：等人工的卡片随进程内存失效，飞书上的旧卡点了只提示过期
  const lost = lostPendingCards(evs);
  if (lost) {
    log(`${t} 重启前的待答卡片已失效（${lost.slice(0, 60)}），已在群里提示`);
    await port.notify(t, `⚠ 重启前的待答卡片已失效（${lost.slice(0, 80)}）——旧卡片点了没用。发「继续 ${t}」：卡点卡会原样重发，问题卡会重新提问；已经说过的内容若已记入反馈会被读到，不用重复。`);
  }
}

// 知识库月度老化审计：制度化而不是指望人记得跑脚本（kb-refresh-audit.ts 躺了一周没人跑）。
// 零成本（只读表+命中日志），到期自动发群；花钱的深检仍由人手动跑脚本
async function kbAuditTick(): Promise<void> {
  if (!dueForAudit(readAuditStamp(), Date.now())) return;
  const board = BitableBoard.fromEnv();
  if (!board) return; // 未配知识表，无从审计
  try {
    await port.notify('知识库', agingSummary(await board.listKnowledge(), lastHitByTitle('knowledge'), Date.now()));
    writeAuditStamp();
    log('知识库老化审计已发群（下次约 30 天后）');
  } catch (e) {
    log(`知识库老化审计失败（明天再试）：${(e as Error).message.slice(0, 160)}`);
  }
}
void kbAuditTick();
setInterval(() => void kbAuditTick(), 24 * 3600 * 1000);

// 空闲自退（停止信号文件）：看门狗计划任务拉起的 daemon 是提权进程，普通 shell 杀不动、连命令行都看不见
// （2026-09-02 实测：任务改成 Limited 照样是 High）。改成约定：start-daemon.ps1 -Stop 杀不动就写
// data/daemon.stop，daemon 每 10 秒看一眼，没有工单在跑或等卡片时自己退出，看门狗 2 分钟内以最新代码拉起。
// 启动即清掉残留的信号文件，否则新进程一起来就自杀、无限循环。
const STOP_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/daemon.stop');
fs.rmSync(STOP_FILE, { force: true });
let stopDeferredLogged = false;
setInterval(() => {
  if (!fs.existsSync(STOP_FILE)) return;
  // 「空闲」= 没有会话在执行。等卡片的工单不算：卡片可恢复（卡点卡原样重发、问题卡由「继续」重问），
  // 而一张几天没人答的上线后补验卡不该让 daemon 永远停不下来（2026-09-03 实测）
  if (sem.inUse > 0) {
    if (!stopDeferredLogged) {
      stopDeferredLogged = true;
      log(`收到停止信号，但有 ${sem.inUse} 个阶段会话在执行，等它们结束再退出`);
    }
    return;
  }
  fs.rmSync(STOP_FILE, { force: true });
  const waiting = [...active.keys()];
  log(`收到停止信号（data/daemon.stop），无会话在执行，自行退出；看门狗会以最新代码拉起${waiting.length ? `。等卡片的工单 ${waiting.join('、')} 的卡将失效，启动时会在群里提示` : ''}`);
  process.exit(0);
}, 10_000);
