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
import { appendEvent, listTickets } from './events.js';
import { FeishuPort, feishuConfigFromEnv, type IncomingMessage } from './feishu/port.js';
import { acquireLock, findOrphanClaude, releaseLock } from './lock.js';
import { readLastRunFor, runByCard, stripQuote } from './followup.js';
import { dataDir } from './paths.js';
import type { ChatRef, Origin } from './ports.js';
import { bindTicketThread, getThread, pushPending, renderPending, routeInThread, takePending, threadOfTicket, type ThreadRec, touchThread } from './threads.js';
import { clearPaused } from './pause.js';
import { Semaphore } from './semaphore.js';
import { describeProjects, loadProjects, projectOfTicket, resolveProject, type Project } from './projects.js';
import { loadTicket, peekTicketRepo, readSnapshot, saveTicket } from './ticket.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { draftRequirementFromChat, execAdhoc, runFollowup } from './daemon/adhoc.js';
import { announceInterruptedTickets } from './daemon/boot.js';
import type { DaemonContext } from './daemon/context.js';
import { dispatch } from './daemon/handlers/index.js';
import { startKbAudit, startStopFilePoller } from './daemon/lifecycle.js';
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
// 退出留痕：2026-09-10 20:44～20:51 daemon 在写回在线表期间无声消失——没有停止信号、没有异常、没有 FATAL，
// 只有看门狗一句 dead。再发生时至少要知道是谁调的 exit、退出码多少、当时占了多少内存
process.on('exit', (code) => {
  console.log(`[daemon] ${new Date().toISOString()} 进程退出 code=${code} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    process.exit(0);
  });
}

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

  // 工单话题（默认开，拍板 2026-09-10）：首次建单在主线发一条根消息并绑定，此后卡片/进度进话题、广播两边各一份。
  // 续跑的单已有话题就沿用；没有（老单）就不补——半截话题比没有更乱
  if (requirement && !threadOfTicket(ticket)) {
    try {
      const chatId = port.routeChat?.(ticket) ?? MAIN_CHAT;
      const root = await port.openTicketThread(ticket, `🆕 工单建立：${requirement.slice(0, 120)}\n（这张单的问答与进度都在这条消息的话题里；主线只留关键节点）`);
      if (root) bindTicketThread(root, ticket, chatId, project.alias);
    } catch (e) {
      log(`${ticket} 开工单话题失败（改走主线）：${(e as Error).message.slice(0, 120)}`);
    }
  }

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

async function handleCommand(c: Command, sender: string, chat?: ChatRef): Promise<void> {
  // chat = 消息来源（群 + 话题）：通用指令答复回到来源；工单类通知不带它，由 routeChat/routeThread 按工单路由
  await dispatch(ctx, c, sender, chat);
}

/**
 * 话题内串行：一个 /run 会话不能被两句话同时 --resume；话题之间并行（仍受全局闸门）。
 * 工单话题不排队——那里的话是答卡/备注，处理是瞬时的，而工单本身在 runner 里跑
 */
const threadQueue = new Map<string, Promise<void>>();
async function onMessage(m: IncomingMessage): Promise<void> {
  const th = m.inThread ? getThread(m.rootId) : null;
  const key = m.inThread && m.rootId && !th?.ticket ? m.rootId : null;
  if (!key) return handleMessage(m, th);
  const prev = threadQueue.get(key);
  const p = (async () => {
    if (prev) {
      await port.notify('执行', '上一句还在处理，这句排在它后面…', { chatId: m.chatId, rootId: m.rootId });
      await prev.catch(() => {});
    }
    // 排队期间前一句可能刚把会话绑到话题上：进场时读的 th 已过期，要重读（2026-09-10 真机：/run 结束 0.6s 后
    // 不 @ 的追问按过期的 th=null 走了「没 @ 又不像指令」的静默退出，人的话被丢了）
    await handleMessage(m, getThread(m.rootId));
  })();
  threadQueue.set(key, p);
  try {
    await p;
  } finally {
    if (threadQueue.get(key) === p) threadQueue.delete(key);
  }
}

async function handleMessage(m: IncomingMessage, th: ThreadRec | null): Promise<void> {
  log(`收到消息 by ${m.sender}${m.mentioned ? '（@我）' : ''}${m.inThread ? `［话题 ${m.rootId?.slice(-8)}${th?.ticket ? `→${th.ticket}` : th?.run ? '→会话' : ''}］` : ''}: ${m.text.slice(0, 80)}`);
  // 回应回到发问的地方：话题里问的答进话题（设计稿 §3.5）
  const origin: Origin = { chatId: m.chatId, rootId: m.inThread ? m.rootId : undefined };
  const slash = parseSlash(m.text);
  // 批量表决后跟着的新诉求：由下方待答卡片分支填进来，走完 answer 上报后当作新工单继续处理
  let newFromBatchTail: string | undefined;
  if (!slash) {
    // 有待确认卡片时，先看这句话是不是在回答它（明确表决/选项才拦截，不劫持指令）
    const ans = port.tryAnswerByText(m.text, false, th?.ticket);
    if (ans.status === 'resolved') {
      await port.notify('回答', `已记录 ${ans.label} → ${ans.answer}${ans.note ? `（补充：${ans.note}）` : ''}`, origin);
      return;
    }
    if (ans.status === 'resolved-batch') {
      await port.notify(
        '回答',
        `已记录 ${ans.labels.length} 项 → ${ans.answer}（${ans.labels.join('、')}）` +
          (ans.skipped.length ? `\n未匹配、仍待回答：${ans.skipped.join('、')}` : ''),
        origin,
      );
      // 表决后跟着一段新诉求：不灌进备注，问一句要不要开新单（2026-09-04 实测缺陷）
      if (!ans.tail) return;
      const NEW = '开新工单';
      const pick = await port.chooseOption(
        '新需求',
        `注意到你在通过之外还说了一段，像是新的需求，没有并进上面的验收：\n> ${ans.tail.slice(0, 160)}\n\n要为它开一个新工单吗？`,
        [NEW, '只是补充说明，忽略'],
        origin,
      );
      if (pick !== NEW) return;
      newFromBatchTail = ans.tail;
    } else if (ans.status === 'ambiguous') {
      await port.notify('回答', ans.detail, origin);
      return;
    }
  }
  let cmd: Command;
  if (newFromBatchTail) {
    cmd = { kind: 'new', requirement: newFromBatchTail };
  } else if (slash) {
    cmd = slash;
    // A 档语义体检：只在明显冲突时拦（如验收阶段用 /amend 报缺陷），保住"斜杠即明确"的效率
    const issue = slashSanityIssue(cmd, ticketContexts().find((c) => c.ticket === (cmd as { ticket?: string }).ticket));
    if (issue) {
      const t = (cmd as { ticket: string }).ticket;
      const pick = await port.chooseOption(t, `${issue}\n\n你想要哪一个？`, ['记为说明（不回退）', '确实要改需求（回退到澄清）'], origin);
      if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: t, text: (cmd as { text: string }).text };
      else if (!pick.startsWith('确实')) {
        await port.notify(t, '已取消', origin);
        return;
      }
    }
  } else {
    // @了机器人 → 一定回应；没 @ → 只在像指令时才花钱分类，避免打扰群聊。
    // 话题里没 @ 的话（拍板 2026-09-11）：不触发、不回复，攒着；下一次有人 @ 时连同那句一起交给会话/工单。
    // 之前「话题里每句都算对话」让同事间的讨论每句触发一轮 resume——太贵也太吵。答卡例外在上面已处理（有明确格式）
    if (!m.mentioned && !looksLikeCommand(m.text)) {
      if (th && m.rootId) log(`话题 ${m.rootId.slice(-8)} 攒下一句（共 ${pushPending(m.rootId, m.sender, stripQuote(m.text))} 条），等 @ 时一并处理`);
      return;
    }
    // 工单话题里只看这张单的现场；带上的「最近一次 /run」也只认话题自己的会话（群指针是主线兜底）
    const contexts = th?.ticket ? ticketContexts().filter((c) => c.ticket === th.ticket) : ticketContexts();
    const lastRun = th ? (th.run ?? null) : readLastRunFor(m.chatId);
    const { command, confidence, error, missingTicket } = await classifyCommand(m.text, contexts, undefined, undefined, lastRun);
    cmd = command;
    // 识别服务炸了 ≠ 没听懂：前者回"重发一次"，后者才是"我不明白你的意思"
    if (error) {
      log(`意图识别失败（已重试）：${error}`);
      await port.notify(
        '指令',
        `识别服务异常，这条消息没能读懂：${error.slice(0, 120)}\n请重发一次；或直接用斜杠指令（\`/run\`、\`/new\`、\`/note LS-00X 内容\`）绕过识别。`,
        origin,
      );
      return;
    }
    const namedTicket = (cmd as { ticket?: string }).ticket;
    log(`意图识别：${cmd.kind}（把握 ${(confidence * 100).toFixed(0)}%）${namedTicket ? ` → ${namedTicket}` : ''}`);

    // 听懂了但缺工单号：工单话题里不用问——话题就是工单（设计稿 §3.4 第 2 条）；主线才问一句
    if (missingTicket && th?.ticket) {
      cmd = { kind: missingTicket.kind, ticket: th.ticket, text: missingTicket.text };
    } else if (missingTicket) {
      const cands = contexts.map((c) => c.ticket).slice(0, 3);
      log(`意图识别：${missingTicket.kind} 但未指明工单，转人工选择`);
      const DIAG = '先诊断一次（不建工单）';
      const pick = await port.chooseOption(
        '指令',
        `我听懂了这是一条${missingTicket.kind === 'amend' ? '需求修改' : '说明/缺陷'}，但没说是哪个工单：\n> ${m.text.slice(0, 120)}\n\n怎么处理？`,
        [DIAG, ...cands],
        origin,
      );
      if (pick === DIAG) cmd = { kind: 'run', text: m.text };
      else if (cands.includes(pick)) cmd = { kind: missingTicket.kind, ticket: pick, text: missingTicket.text };
      else {
        await port.notify('指令', '已取消', origin);
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
          origin,
        );
        if (pick.startsWith('开一个新工单')) cmd = { kind: 'new', requirement: am.text };
        else if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: am.ticket, text: am.text };
        else {
          await port.notify(am.ticket, '已取消', origin);
          return;
        }
      }
    }

    // 分类为"回答卡片" → 走待答项路由（自由文本也接受）
    if (cmd.kind === 'answer') {
      const c = cmd;
      const composed = c.target ? `${c.target} ${c.text}` : c.text;
      const r = port.tryAnswerByText(composed, true);
      if (await reportAnswer(r, origin)) return;
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
        origin,
      );
      if (pick.startsWith('记为说明')) cmd = { kind: 'note', ticket: t, text: m.text };
      else if (pick === '取消') {
        await port.notify(t, '已取消', origin);
        return;
      }
    }

    if (cmd.kind === 'unknown') {
      // 没听懂但有待答卡片 → 当作自由文本答案（人的话不该被丢掉）
      if (await reportAnswer(port.tryAnswerByText(m.text, true, th?.ticket), origin)) return;
      if (!m.mentioned && !th) return; // 没 @ 又没听懂：安静退出（话题里除外，见上）
    }
  }

  // 话题路由（设计稿 §3.4）：话题绑了工单 → 这句一定是该单的事；绑了会话 → 续它。确定性优先于分类器的猜测
  if (th || (m.inThread && runByCard(m.rootId))) {
    const routed = routeInThread(cmd, th, m.text, !!runByCard(m.rootId));
    if (routed !== cmd) log(`话题路由：${cmd.kind} → ${routed.kind}${(routed as { ticket?: string }).ticket ? ` @${(routed as { ticket?: string }).ticket}` : ''}`);
    cmd = routed;
    if (th?.ticket && m.rootId) touchThread(m.rootId);
  }

  // 话题里攒下的没 @ 的话：这次被 @ 了，一并带上（写进续聊答复 / 工单说明 / 需求原文），然后清空
  if (th && m.rootId) {
    const pending = takePending(m.rootId);
    if (pending.length) {
      const digest = renderPending(pending);
      if (cmd.kind === 'followup' || cmd.kind === 'run' || cmd.kind === 'note' || cmd.kind === 'amend') cmd = { ...cmd, text: `${cmd.text}\n\n${digest}` };
      else if (cmd.kind === 'new') cmd = { ...cmd, requirement: `${cmd.requirement}\n\n${digest}` };
      log(`话题 ${m.rootId.slice(-8)} 连同攒下的 ${pending.length} 条一起处理`);
      await port.notify('执行', `已连同上面 ${pending.length} 条讨论一起处理`, origin);
    }
    // 群里置顶的文件一并带上：pin 是人「指给你看」的自然方式，而人不会每次都说「置顶」二字
    // （真机 2026-09-11：pin 了新提示词 xlsx 后 @「取文档中 新提示词 sheet」，只认 pin/置顶 关键词就漏了）。文件按 key 落盘，重复带只是多一行路径
    if (cmd.kind === 'followup' || cmd.kind === 'run' || cmd.kind === 'note' || cmd.kind === 'amend' || cmd.kind === 'new') {
      const pinned = await port.pinnedFiles(m.chatId);
      if (pinned.length) {
        const lines = pinned.map((f) => `[群里置顶的文件 ${f.name} 已保存：${f.path}——若与本句有关请用 Read 工具查看]`).join('\n');
        cmd = cmd.kind === 'new' ? { ...cmd, requirement: `${cmd.requirement}\n\n${lines}` } : { ...cmd, text: `${cmd.text}\n\n${lines}` };
        log(`话题 ${m.rootId.slice(-8)} 带上 ${pinned.length} 个置顶文件：${pinned.map((f) => f.name).join('、')}`);
      }
    }
    // 话题里的确认不发文字，给你的消息加个「收到」表情（结果卡回来就是完成）
    if (cmd.kind === 'followup' || cmd.kind === 'run') void port.react(m.messageId, 'Get');
  }

  // 分级确认：改变流程走向的一律先问，卡片上写清"我理解为什么、会导致什么"
  // 引用了机器人发过的结果卡再说话（/re、追问、甚至被判成别的）→ 精确续那次会话，不看「最近一次」指针
  // （2026-09-04 实测：引用 lakeghost 的结果卡，按全局指针续到了 odoo-product 的会话）
  if (m.quotedMessageId && runByCard(m.quotedMessageId) && ['followup', 'run', 'unknown', 'answer'].includes(cmd.kind)) {
    const own = m.text.split('\n\n【用户引用的消息】')[0].replace(/^\/re\s*/i, '').trim() || '继续';
    log(`引用结果卡 ${m.quotedMessageId} → 续那次会话（原判定 ${cmd.kind}）`);
    cmd = { kind: 'followup', text: own, quotedMessageId: m.quotedMessageId };
  }

  if (needsConfirm(cmd)) {
    const t = (cmd as { ticket: string }).ticket;
    if (!(await port.confirmCommand(t, describeCommand(cmd), origin))) {
      await port.notify(t, '已取消', origin);
      return;
    }
  }

  try {
    await handleCommand(cmd, m.sender, origin);
  } catch (e) {
    log(`指令处理失败：${(e as Error).message}`);
    await port.notify('指令', `处理失败：${(e as Error).message}`, origin);
  }
}

/** 统一回执待答项路由结果；返回是否已处理完毕 */
async function reportAnswer(r: ReturnType<FeishuPort["tryAnswerByText"]>, chat?: ChatRef): Promise<boolean> {
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
// 工单绑了话题就把它的卡片/进度投进话题（src/threads.ts；广播另在主线留一份）
port.routeThread = (t) => threadOfTicket(t)?.rootId;
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
  runFollowup: (reply, chat, quotedMessageId) => runFollowup(ctx, reply, chat, quotedMessageId),
  draftRequirementFromChat: (project, last) => draftRequirementFromChat(ctx, project, last),
};
log(`daemon 就绪：并发上限 ${cfg.maxConcurrency}，项目 ${describeProjects(projects)}（默认 ${cfg.defaultProject}）`);
await port.notify('流水线', `编排器已上线。并发上限 ${cfg.maxConcurrency}。\n${helpText()}`);

await announceInterruptedTickets(ctx);
startKbAudit(ctx);
startStopFilePoller(ctx, path.join(dataDir(), 'daemon.stop'));
