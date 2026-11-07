import { fetchGlossaryBrief } from '../bitable/sync.js';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR } from '../config.js';
import { projectReq } from '../bitable/reqSync.js';
import { isClosure, listTickets, readEvents, type PipelineEvent } from '../events.js';
import { DROPPED } from '../feishu/port.js';
import { type ChatRef, chatIdOf, rootIdOf } from '../ports.js';
import { describeProjects, mentionedProject, nextTicketId, projectOfTicket, resolveProject, type Project } from '../projects.js';
import {
  composeInterviewPrompt,
  createReq,
  findReqByTicket,
  intakeContextOf,
  listReqs,
  OPEN_STATUSES,
  parseBrief,
  parseRequirementCard,
  renderRequirementCard,
  queuedFor,
  readReq,
  remainingSplits,
  type Requirement,
  roundNudge,
  saveReq,
  SCHEDULE_REMIND_MS,
  type TicketLoad,
  ticketRequirementOf,
  WIP_LIMIT,
  wipOf,
} from '../requirements.js';
import { readSticky } from '../sticky.js';
import { readSnapshot } from '../ticket.js';
import { bindReqThread, getThread } from '../threads.js';
import type { DaemonContext } from './context.js';

/**
 * 需求池的交互与编排（设计稿 docs/design/2026-09-23-requirements-pool.md）。
 * 状态只在 data/requirements/*.json 里；卡片是视图——等卡的流程都是「读状态 → 发卡 → 等 → 重读状态再动」，
 * 卡丢了（重启）由 recoverReqs 按状态重发，状态被别处改了（新版说明、人在表外处理）等待方自己放弃
 */

/** 文字消息里 @ 人；卡片 markdown 的写法不同（atCard） */
const at = (openId: string): string => `<at user_id="${openId}"></at>`;
const atCard = (openId: string): string => `<at id=${openId}></at>`;
const threadOf = (r: Requirement): ChatRef => ({ chatId: r.chatId, rootId: r.rootId });

function save(ctx: DaemonContext, r: Requirement): Requirement {
  const next = saveReq(r);
  void projectReq(next).catch((e: Error) => ctx.log(`需求池投影失败（不影响流程）：${e.message.slice(0, 120)}`));
  return next;
}

/** 项目归属：显式 > 原话点名 > 群绑定 > 群粘性 > 唯一项目 > 问人（和建单一样不静默用默认项目：需求进错项目，后面整条链都错） */
async function resolveReqProject(ctx: DaemonContext, text: string, explicit: string | undefined, chat?: ChatRef): Promise<Project | null> {
  const { projects, port } = ctx;
  const chatId = chatIdOf(chat);
  const named = mentionedProject(projects, text);
  const direct =
    resolveProject(projects, explicit) ??
    (named?.exact ? named.project : null) ??
    (chatId ? (projects.find((p) => p.chatId === chatId) ?? null) : null) ??
    (projects.length === 1 ? projects[0] : null);
  if (direct) return direct;
  const sticky = chatId ? readSticky(chatId, projects) : null;
  const options = [...projects].sort((a, b) => (a.alias === sticky?.alias ? -1 : b.alias === sticky?.alias ? 1 : 0));
  const pick = await port.chooseOption('需求', `这个需求属于哪个项目？\n> ${text.slice(0, 100)}`, options.map((p) => p.alias), chat);
  return projects.find((p) => p.alias === pick) ?? null;
}

/** 开一条需求并跑第一轮访谈 */
export async function startReq(ctx: DaemonContext, text: string, sender: string, chat: ChatRef | undefined, explicitProject?: string): Promise<void> {
  const { port, log } = ctx;
  const chatId = chatIdOf(chat) ?? ctx.MAIN_CHAT;
  const rootId = rootIdOf(chat);
  const th = rootId ? getThread(rootId) : null;
  if (th?.ticket) {
    await port.notify('需求', `这个话题是工单 ${th.ticket} 的；新需求请回主线用 /req 提，这里的话会记成 ${th.ticket} 的说明。`, chat);
    return;
  }
  if (th?.req) {
    await port.notify('需求', `这个话题已经在梳理 ${th.req}，直接在这里 @我 接着说就行。`, chat);
    return;
  }
  const project = await resolveReqProject(ctx, text, explicitProject ?? th?.run?.project, chat);
  if (!project) {
    await port.notify('需求', `没选项目，已取消（可用：${describeProjects(ctx.projects)}）`, chat);
    return;
  }
  // 话题里开需求：就用这个话题，已有的会话接着用（前面聊的都算访谈材料）；主线开需求：发一条根消息，访谈进它的话题
  let r = createReq({ project: project.alias, requester: sender, chatId, rootId: rootId ?? '', raw: text });
  if (!rootId) {
    const root = await port.openThread?.(chatId, `📝 ${r.id} 需求梳理：${text.slice(0, 120)}\n（我会在这条消息的话题里跟你把需求聊清楚；聊完你确认、负责人排期后自动建工单）`);
    if (!root) {
      saveReq({ ...r, status: '不做', note: '开话题失败' });
      await port.notify('需求', '开需求话题失败，请稍后重试。', chat);
      return;
    }
    r = { ...r, rootId: root };
  }
  r = save(ctx, r);
  bindReqThread(r.rootId, r.id, chatId, project.alias);
  await port.notify(r.id, `已收录 ${r.id}，正在提炼标题和需求说明。原始反馈已保存，后续可在本话题 @我 补充。`, threadOf(r));
  log(`${r.id} 开始梳理（${project.alias}，by ${sender.slice(-6)}）${rootId ? '，沿用本话题' : ''}：${text.slice(0, 80)}`);
  const glossary = await fetchGlossaryBrief(text, project.alias);
  const prompt = `${glossary ? `${glossary}\n---\n` : ''}${composeInterviewPrompt(r, { openReqs: listReqs().filter((o) => OPEN_STATUSES.includes(o.status)), fromThread: !!th?.run })}`;
  const prev = th?.run;
  await ctx.execAdhoc(project, text, prompt, [], prev ? prev.chain + 1 : 0, { chat: threadOf(r), resumeSessionId: prev?.sessionId, prev });
}

/** 访谈里的续轮（execAdhoc 拼提示词时调）：第 3 轮起逼出说明 */
export function reqNudgeFor(rootId: string | undefined): string {
  const req = rootId ? getThread(rootId)?.req : undefined;
  const r = req ? readReq(req) : null;
  if (!r || (r.status !== '梳理中' && r.status !== '待确认')) return '';
  const skill = path.join(PLUGIN_DIR, 'skills', 'pipeline-intake', 'SKILL.md');
  return `\n\n${composeInterviewPrompt(r, { openReqs: listReqs().filter(o => OPEN_STATUSES.includes(o.status)) })}${roundNudge(r)}\n${fs.existsSync(skill) ? fs.readFileSync(skill, 'utf-8') : ''}`;
}

export function requirementForThread(rootId: string | undefined): Requirement | null {
  const id = rootId ? getThread(rootId)?.req : undefined;
  return id ? readReq(id) : null;
}

export function beginReqTurn(ctx: DaemonContext, rootId: string | undefined, text: string): void {
  const r = requirementForThread(rootId);
  if (!r || !['梳理中', '待确认'].includes(r.status)) return;
  ctx.port.dropPending?.(r.id);
  save(ctx, { ...r, status: '梳理中', processing: '整理中', processingError: undefined, confirmedRevision: undefined,
    supplements: text === r.raw || r.supplements?.at(-1)?.text === text ? r.supplements : [...(r.supplements ?? []), { text, at: new Date().toISOString() }] });
}

export function failReqTurn(ctx: DaemonContext, rootId: string | undefined): void {
  const r = requirementForThread(rootId);
  if (r?.processing === '整理中') save(ctx, { ...r, processing: '整理失败', processingError: '本轮未完成，原话和已有卡片已保留。在原话题 @我 说“重试整理”可继续。' });
}

/**
 * 需求话题里每跑完一轮会话（execAdhoc 调）：记轮次；出了《需求说明》就发确认卡；判了「无需开发」就关单。
 * 不能等卡：这里还占着并发闸门，确认卡可能几天没人点
 */
export async function afterReqTurn(ctx: DaemonContext, rootId: string, output: string, openConfirmation = true): Promise<void> {
  const req = getThread(rootId)?.req;
  let r = req ? readReq(req) : null;
  if (!r || (r.status !== '梳理中' && r.status !== '待确认')) return;
  r = { ...r, rounds: r.rounds + 1 };
  const card = parseRequirementCard(output);
  const parsed = card ? parseBrief(renderRequirementCard(card)) : null;
  if (!parsed) {
    save(ctx, { ...r, processing: '整理失败', processingError: '未收到有效需求卡片，已有信息已保留。在原话题 @我 说“重试整理”可继续。' });
    await ctx.port.notify(r.id, '本轮整理未形成有效需求卡片，已保留原始反馈和已有说明，可在这里 @我 重试整理。');
    return;
  }
  // 新版说明作废旧的确认卡：人对着旧卡点「通过」确认的会是一份已经不存在的说明
  ctx.port.dropPending?.(r.id);
  const ready = card ? card.ready : !!parsed.title;
  r = save(ctx, { ...r, status: ready ? '待确认' : '梳理中', card: card ?? undefined, revision: (r.revision ?? 0) + 1, confirmedRevision: undefined,
    processing: ready ? '已整理' : '等待补充', processingError: undefined,
    brief: parsed.brief, title: parsed.title || r.title, splits: parsed.splits, dupOf: parsed.dups[0] });
  ctx.log(`${r.id} 需求说明第 ${r.rounds} 轮出稿：${r.title}（拆 ${Math.max(1, r.splits?.length ?? 0)} 张）`);
  if (ready && openConfirmation) void confirmLoop(ctx, r.id);
}

const splitLines = (r: Requirement): string =>
  r.splits?.length ? r.splits.map((s, i) => `${i + 1}. ${s}`).join('\n') : '1 张（不拆）';

/** 提出人确认：通过 → 进池等排期；驳回 → 带着意见再访谈一轮 */
export async function confirmLoop(ctx: DaemonContext, id: string): Promise<void> {
  const r0 = readReq(id);
  if (!r0 || r0.status !== '待确认') return;
  const owner = ownerOf(ctx, r0);
  const d = await ctx.port.confirmGate(
    id,
    '需求确认',
    `${atCard(r0.requester)} **${id}「${r0.title}」第 ${r0.revision ?? 0} 版待确认**\n\n${r0.brief ?? ''}\n\n建议拆成：\n${splitLines(r0)}\n\n通过 = 就是我要的，进需求池等负责人排期；有补充会先更新说明再请你确认。驳回 = 在备注里写要改哪里，我接着改。`,
    [],
    undefined,
    { allowed: [r0.requester, ...(owner ? [owner] : [])] },
  );
  if (d.dropped) return;
  const r = readReq(id);
  if (!r || r.status !== '待确认' || r.revision !== r0.revision || r.brief !== r0.brief) return;
  if (d.approved && d.note?.trim()) {
    const text = `确认时补充：${d.note.trim()}。请更新需求卡片，保留原有范围，改动后重新确认。`;
    save(ctx, { ...r, status: '梳理中', note: `确认时补充：${d.note.trim()}`, supplements: [...(r.supplements ?? []), { text, at: new Date().toISOString() }] });
    await ctx.runFollowup(text, threadOf(r));
    return;
  }
  if (d.approved) {
    save(ctx, { ...r, status: '待排期', confirmedRevision: r.revision });
    ctx.log(`${id} 提出人已确认，进池待排期`);
    void scheduleLoop(ctx, id);
    return;
  }
  const text = `提出人对需求说明的修改意见：${d.note?.trim() || '（没写具体意见——请用一两个问题问清楚哪里不对，不要猜）'}\n请据此修改，改好后重新输出完整产品卡片。`;
  save(ctx, { ...r, status: '梳理中', note: d.note, supplements: [...(r.supplements ?? []), { text, at: new Date().toISOString() }] });
  ctx.log(`${id} 提出人驳回说明：${(d.note ?? '').slice(0, 80)}`);
  await ctx.runFollowup(
    text,
    threadOf(r),
  );
}

function ownerOf(ctx: DaemonContext, r: Requirement): string | undefined {
  return ctx.projects.find((p) => p.alias === r.project)?.owner;
}

export const SCHEDULE = '排期';
export const SHELVE = '搁置';
export const DECLINE = '不做';
const MERGE = (id: string) => `并入 ${id}`;

/** 负责人排期（只认负责人；项目没配负责人时谁都可以，卡上写明） */
export async function scheduleLoop(ctx: DaemonContext, id: string, opts: { announce?: boolean } = {}): Promise<void> {
  const r0 = readReq(id);
  if (!r0 || r0.status !== '待排期') return;
  const owner = ownerOf(ctx, r0);
  const dups = r0.dupOf && readReq(r0.dupOf) && OPEN_STATUSES.includes(readReq(r0.dupOf)!.status) ? [r0.dupOf] : [];
  // 决策在话题里做，主线指一句路并 @ 负责人——负责人不一定跟过这个话题。重启恢复时不再指路：每次部署都 @ 一遍就是刷屏
  if (opts.announce !== false) await ctx.port.notify('需求', `${owner ? at(owner) : ''} ${id}「${r0.title}」提出人已确认，等排期（卡在 ${id} 的话题里）`, r0.chatId);
  const pick = await ctx.port.chooseOption(
    id,
    [
      `**${id}「${r0.title}」等排期**${owner ? `（${atCard(owner)}）` : '（本项目没配负责人，谁都可以点）'}`,
      '',
      `建议拆成：\n${splitLines(r0)}`,
      ...(dups.length ? ['', `⚠ 可能和 ${dups[0]} 重复，见需求说明的「疑似重复」`] : []),
      '',
      `排期 = 按拆分自动建工单（${r0.project} 同时在制最多 ${WIP_LIMIT} 张，满了就排队，有单闭环自动顶上）`,
    ].join('\n'),
    [SCHEDULE, SHELVE, DECLINE, ...dups.map(MERGE)],
    undefined,
    { allowed: owner ? [owner] : undefined },
  );
  if (pick === DROPPED) return;
  const r = readReq(id);
  if (!r || r.status !== '待排期') return;
  if (pick === SCHEDULE) {
    save(ctx, { ...r, status: '已排期', scheduledAt: new Date().toISOString() });
    ctx.log(`${id} 已排期`);
    await pumpQueue(ctx, r.project);
    return;
  }
  if (pick.startsWith('并入 ')) {
    const target = pick.slice(3);
    save(ctx, { ...r, status: '重复', dupOf: target });
    const t = readReq(target);
    if (t) await ctx.port.notify(target, `${id} 被负责人并入这条需求。它的原话：\n> ${r.raw.slice(0, 300)}`);
    await ctx.port.notify(id, `${at(r.requester)} 负责人把 ${id} 并入了 ${target}，后续进度看 ${target}。`);
    return;
  }
  const status = pick === SHELVE ? '搁置' : '不做';
  save(ctx, { ...r, status, note: `负责人选择${status}` });
  ctx.log(`${id} 负责人选择${status}`);
  await ctx.port.notify(id, `${at(r.requester)} 负责人把 ${id} 标为「${status}」。需要重新讨论可以在这里 @我，或直接找负责人。`);
}

// ── 转工单与排队 ─────────────────────────────────────────────

/** 工单真正闭环的事件（compound 生成交付文档时也发 type=done，那个不算） */
export { isClosure };

function ticketLoads(ctx: DaemonContext): TicketLoad[] {
  return listTickets().map((t) => {
    const evs = readEvents(t);
    const st = readSnapshot(t);
    return {
      ticket: t,
      project: st?.project ?? projectOfTicket(ctx.projects, t)?.alias,
      closed: evs.some(isClosure),
      halted: !!st?.haltedReason,
      lastEventAt: evs.length ? Date.parse(evs[evs.length - 1].ts) : 0,
    };
  });
}

/** 同一项目的出队串行：排期与工单闭环可能同时触发，名额不能被算两遍 */
const pumping = new Map<string, Promise<void>>();

export function pumpQueue(ctx: DaemonContext, project: string): Promise<void> {
  const prev = pumping.get(project) ?? Promise.resolve();
  const next = prev.then(() => pumpOnce(ctx, project)).catch((e: Error) => ctx.log(`需求出队失败（${project}）：${e.message.slice(0, 160)}`));
  pumping.set(project, next);
  return next;
}

async function pumpOnce(ctx: DaemonContext, projectAlias: string): Promise<void> {
  const project = ctx.projects.find((p) => p.alias === projectAlias);
  if (!project) return;
  const wip = wipOf(projectAlias, ticketLoads(ctx));
  // 刚建的单事件文件可能还没落盘（runner 在后台起），编号要把这一轮已分配的也算上
  const allocated: string[] = [];
  for (let r of queuedFor(projectAlias)) {
    for (const split of remainingSplits(r)) {
      if (wip.length >= WIP_LIMIT) {
        await ctx.port.notify(r.id, `${r.id} 排队中：${projectAlias} 在制已满（${wip.join('、')}），有单闭环后自动建。`);
        ctx.log(`${r.id} 排队：${projectAlias} 在制 ${wip.length}/${WIP_LIMIT}`);
        return;
      }
      const ticket = nextTicketId(project, [...listTickets(), ...allocated]);
      allocated.push(ticket);
      const msg = await ctx.startTicket(ticket, projectAlias, ticketRequirementOf(r, split), intakeContextOf(r, split));
      if (!msg.includes('已启动')) {
        await ctx.port.notify(r.id, `${r.id} 建单没成功（${ticket}）：${msg}。它还在排队，下次有工单闭环或 daemon 重启时会自动再试。`);
        ctx.log(`${r.id} 建单失败：${msg}`);
        return;
      }
      wip.push(ticket);
      r = save(ctx, { ...r, tickets: [...r.tickets, ticket] });
      ctx.log(`${r.id} → ${ticket}`);
      await ctx.port.notify(r.id, `${r.id} 已建工单 ${ticket}${split ? `：${split}` : ''}（进度在主线 ${ticket} 的话题里）`);
    }
    save(ctx, { ...r, status: '已转工单' });
  }
}

/** 工单闭环（daemon 订阅事件调）：回推提出人，全部闭环就结单；腾出名额就出队 */
export async function onTicketClosed(ctx: DaemonContext, ticket: string): Promise<void> {
  const r = findReqByTicket(ticket);
  const project = r?.project ?? projectOfTicket(ctx.projects, ticket)?.alias;
  if (r && !(r.delivered ?? []).includes(ticket)) {
    const delivered = [...(r.delivered ?? []), ticket];
    const total = r.splits?.length || 1;
    const all = delivered.length >= total && r.tickets.length >= total;
    save(ctx, { ...r, delivered, ...(all ? { status: '已交付' as const } : {}) });
    await ctx.port.notify(r.id, `${at(r.requester)} ${r.id} 的 ${ticket} 已交付（${delivered.length}/${total}）${all ? '，这条需求全部完成 🎉' : ''}`);
    ctx.log(`${r.id} 的 ${ticket} 已交付（${delivered.length}/${total}）`);
  }
  if (project) await pumpQueue(ctx, project);
}

// ── 重启恢复与巡检 ─────────────────────────────────────────────

const RECOVER_WINDOW_MS = 7 * 24 * 3600_000;

/** 启动时按状态把丢了的卡重发（7 天内动过的；更老的交给每日巡检提醒），排队的试着出队 */
export function recoverReqs(ctx: DaemonContext, now = Date.now()): void {
  const all = listReqs();
  let n = 0;
  for (const r of all) {
    if (r.processing === '整理中') save(ctx, { ...r, processing: '整理失败', processingError: '服务重启中断了整理，已有材料已保留。在原话题 @我 重试整理。' });
    const fresh = now - Date.parse(r.updatedAt) <= RECOVER_WINDOW_MS;
    if (r.status === '待确认' && fresh) {
      void confirmLoop(ctx, r.id);
      n++;
    } else if (r.status === '待排期' && fresh) {
      void scheduleLoop(ctx, r.id, { announce: false });
      n++;
    }
  }
  for (const p of new Set(all.filter((r) => r.status === '已排期').map((r) => r.project))) void pumpQueue(ctx, p);
  if (n) ctx.log(`需求池：重发 ${n} 张待确认/待排期卡`);
}

/** 每日巡检：待排期超 14 天的提醒负责人一次（重发排期卡） */
export function remindStale(ctx: DaemonContext, now = Date.now()): string[] {
  const hit: string[] = [];
  for (const r of listReqs()) {
    // 按「多久没动」算：刚确认的老需求 updatedAt 是新的，启动恢复已经给它发过卡，这里不重复
    if (r.status !== '待排期' || r.remindedAt || now - Date.parse(r.updatedAt) < SCHEDULE_REMIND_MS) continue;
    saveReq({ ...r, remindedAt: new Date(now).toISOString() });
    void scheduleLoop(ctx, r.id);
    hit.push(r.id);
  }
  if (hit.length) ctx.log(`需求池：${hit.join('、')} 待排期超 14 天，已提醒负责人`);
  return hit;
}

export function startReqTicker(ctx: DaemonContext): void {
  setInterval(() => remindStale(ctx), 24 * 3600_000);
}

/** 事件订阅：工单闭环 → onTicketClosed */
export function reqEventListener(ctx: DaemonContext): (e: PipelineEvent) => void {
  return (e) => {
    if (isClosure(e)) void onTicketClosed(ctx, e.ticket).catch((err: Error) => ctx.log(`需求交付回推失败：${err.message.slice(0, 160)}`));
  };
}
