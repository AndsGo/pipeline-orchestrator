import { listTickets } from '../../events.js';
import { describeLastRun, intakeContextFromLastRun, isDraftFromChatRequest, readLastRun } from '../../followup.js';
import { mentionedProject, nextTicketId, projectOfTicket, resolveProject, type Project } from '../../projects.js';
import { readSticky, writeSticky } from '../../sticky.js';
import { type ChatRef, chatIdOf } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'new'>, _sender: string, chat?: ChatRef): Promise<void> {
  const { port, projects } = ctx;
  let requirement = c.requirement;
  let ticketPick = c.ticket;
  let project: Project | null = null;
  // 零输入建单：/new 不带正文（或「按刚才聊的建单」）→ 把最近的 /run 对话压成需求原文，弹卡确认后再建。
  // 对话本身走的是 --resume 真续会话；这里只读落盘的整段记录，不重放会话
  if (isDraftFromChatRequest(requirement)) {
    const last = readLastRun();
    if (!last) {
      await port.notify('新工单', '「/new」后面要跟需求原文；或者先用 /run 把问题聊清楚，再发一句「/new」，我会把对话整理成需求给你确认。', chat);
      return;
    }
    const lp = projects.find((p) => p.alias === last.project) ?? null;
    const bound = chat ? projects.find((p) => p.chatId === chatIdOf(chat)) : undefined;
    if (!lp || (bound && bound.alias !== lp.alias)) {
      await port.notify(
        '新工单',
        `最近的 /run 对话 ${describeLastRun(last)} 是在项目 ${last.project} 上${bound ? `，本群绑定的是 ${bound.alias}` : ''}；请到对应项目的群里建，或直接写需求原文。`,
        chat,
      );
      return;
    }
    await port.notify('新工单', `正在把 ${describeLastRun(last)} 及其续聊整理成需求原文（约 1 分钟）…`, chat);
    const draft = await ctx.draftRequirementFromChat(lp, last);
    if (!draft) {
      await port.notify('新工单', '整理失败，请直接写需求原文：/new <需求>', chat);
      return;
    }
    ticketPick = ticketPick ?? nextTicketId(lp, listTickets());
    const d = await port.confirmGate(
      ticketPick,
      '建单确认',
      `${draft}\n\n通过 → 按上面这段需求建单 ${ticketPick}（备注里写的补充会并入需求）；驳回 → 取消，不建单`,
      [],
    );
    if (!d.approved) {
      await port.notify('新工单', `已取消建单${d.note ? `（${d.note.slice(0, 80)}）` : ''}`, chat);
      return;
    }
    requirement = d.note?.trim() ? `${draft}\n\n用户在确认建单时补充：${d.note.trim()}` : draft;
    project = lp;
  }
  // 项目来源优先级：显式指定 > 工单号前缀 > 需求原文里指名 > 群绑定 > 唯一项目 > 问人。
  // 粘性不静默用于建单（建错项目的工单代价高），只把它顶到问人卡片的推荐位
  const mention = mentionedProject(projects, requirement);
  project ??=
    resolveProject(projects, c.repo) ?? (ticketPick ? projectOfTicket(projects, ticketPick) : null) ??
    (mention?.exact ? mention.project : null) ??
    (chat ? (projects.find((p) => p.chatId === chatIdOf(chat)) ?? null) : null) ??
    (projects.length === 1 ? projects[0] : null);
  if (!project) {
    const sticky = chat ? readSticky(chatIdOf(chat)!, projects) : null;
    const options = [...projects].sort((a, b) => (a.alias === sticky?.alias ? -1 : b.alias === sticky?.alias ? 1 : 0));
    const pick = await port.chooseOption(
      '新工单',
      `这个需求属于哪个项目？\n> ${requirement.slice(0, 100)}`,
      options.map((p) => `${p.alias}（${p.prefix}-${p.alias === sticky?.alias ? '，本群当前上下文' : ''}）`),
      chat,
    );
    project = projects.find((p) => pick.startsWith(p.alias)) ?? null;
    if (!project) {
      await port.notify('新工单', '未选择项目，已取消', chat);
      return;
    }
  }
  if (chat && !projects.some((p) => p.chatId === chatIdOf(chat))) writeSticky(chatIdOf(chat)!, project.alias);
  const ticket = ticketPick ?? nextTicketId(project, listTickets());
  // 建单自动附带最近一次 /run 的整段对话（LS-013 教训：结论留在续聊里，工单只带走一句话）
  const context = intakeContextFromLastRun(readLastRun(), project.alias);
  await port.notify(ticket, await ctx.startTicket(ticket, project.alias, requirement, context ?? undefined), chat);
  if (context) await port.notify(ticket, `已自动附带建单前的 /run 对话记录进 00-intake.md（澄清阶段会参考）`, chat);
}
