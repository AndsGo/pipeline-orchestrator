import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import type { Answer } from '../backfill.js';
import { imFileType, isImage } from '../outbox.js';
import { dataDir } from '../paths.js';
import { type ChatRef, chatIdOf, type GateDecision, type InteractionPort, rootIdOf } from '../ports.js';
import type { OpenQuestion } from '../types.js';
import {
  chooseCard,
  confirmCard,
  dashboardCard,
  gateCard,
  questionsCard,
  resolvedCard,
  resultCard,
  statusCard,
  type CardAction,
  type QuestionItem,
} from './card.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 编排器消息投递的群 chat_id（bot 须已入群） */
  chatId: string;
}

/** 一张卡上的一组问题（合并卡片：任一项被回答后原位更新，其余按钮保留） */
interface QuestionGroup {
  ticket: string;
  items: QuestionItem[];
  messageId?: string;
}

interface Pending {
  resolve: (value: { value: string; note?: string }) => void;
  resolvedTitle: string;
  /** 替换卡片保留的原始上下文（问题/摘要）——点完不能只剩结果 */
  contextBody: string;
  kind: 'answer' | 'gate';
  /** Q1 / plan-approval，用于文字回答时定位 */
  label: string;
  options?: string[];
  group?: QuestionGroup;
  /** 所属工单，供按工单过滤待答项 */
  ticket?: string;
  /**
   * 只接受选项匹配，自由文本不落位。控制流卡（chooseOption）必开：
   * 真机事故——「它的回答我不会了」被当自由文本答案落进低置信确认卡，意外确认建了工单。
   */
  strictOptions?: boolean;
}

/** 调用方给的目标可以是群 id / Origin / 已解析的 {chatId, rootId}：统一成后者 */
function asTarget(to?: ChatRef | { chatId?: string; rootId?: string }): { chatId?: string; rootId?: string } {
  if (to === undefined) return {};
  if (typeof to === 'string') return { chatId: to };
  return { chatId: to.chatId, rootId: to.rootId };
}

const APPROVE = /^(通过|同意|批准|可以|没问题|ok|approve|yes|y)/i;
const REJECT = /^(驳回|不通过|拒绝|否决|reject|no|n)/i;

export type TextAnswerResult =
  | { status: 'resolved'; label: string; answer: string; note?: string }
  | { status: 'resolved-batch'; labels: string[]; answer: string; skipped: string[]; tail?: string }
  | { status: 'ambiguous'; detail: string }
  | { status: 'none' };

/** 群消息（@bot 或 / 开头的指令），由 daemon 注册处理 */
export interface IncomingMessage {
  chatId: string;
  text: string;
  sender: string;
  messageId: string;
  /** 消息里是否 @ 了机器人——@了就一定要回应，这是群里最基本的礼貌 */
  mentioned: boolean;
  /** 引用回复时被引用消息的 ID：引用的是机器人发过的结果卡 → 精确续那次会话（见 followup.runByCard） */
  quotedMessageId?: string;
  /** 话题根消息 id（message.root_id）。只有 inThread 为真时才是话题——普通引用回复也带 root_id */
  rootId?: string;
  /** 消息在话题里（message.thread_id 非空）。话题 = 会话：见 src/threads.ts */
  inThread: boolean;
}

/**
 * 飞书交互端口：WebSocket 长连接（免公网）同时承载
 *  - card.action.trigger：卡片按钮 + 表单输入回调
 *  - im.message.receive_v1：群里 @bot 的自然语言/斜杠指令
 * 回调路由与 SDK 解耦：handleCardAction 可单测。
 */
export class FeishuPort implements InteractionPort {
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private client: lark.Client,
    private ws: lark.WSClient | null,
    private cfg: FeishuConfig,
  ) {}

  static async create(cfg: FeishuConfig, onMessage?: (m: IncomingMessage) => void): Promise<FeishuPort> {
    const client = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
    const ws = new lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret });
    const port = new FeishuPort(client, ws, cfg);

    const handlers: Record<string, (data: never) => Promise<unknown>> = {
      'card.action.trigger': (async (data: { action?: { value?: unknown; form_value?: Record<string, string> } }) => {
        const update = port.handleCardAction(
          data?.action?.value as CardAction | undefined,
          data?.action?.form_value,
        );
        return update
          ? { toast: { type: 'success', content: '已收到' }, card: { type: 'raw', data: update } }
          : { toast: { type: 'info', content: '该卡片已处理或已过期' } };
      }) as (data: never) => Promise<unknown>,
    };
    if (onMessage) {
      handlers['im.message.receive_v1'] = (async (data: {
        message?: {
          chat_id?: string;
          content?: string;
          message_id?: string;
          message_type?: string;
          /** 引用回复时带上被引用消息的 ID——内容要另调 API 拉（需 im:message.group_msg 权限） */
          parent_id?: string;
          /** 回复链的根消息；话题里的消息 root_id 就是话题根。普通引用回复也有，所以话题判定看 thread_id */
          root_id?: string;
          /** 消息属于某个话题时非空 */
          thread_id?: string;
        };
        sender?: { sender_id?: { open_id?: string } };
      }) => {
        const parsed = parseMessageText(data?.message?.content, data?.message?.message_type);
        if (parsed) {
          let text = parsed.text;
          const inThread = !!data.message?.thread_id;
          // 真机字段取值留痕（话题回复 / 引用回复 / 话题内引用 三种形态要对得上设计稿 §3.3 的假设）
          if (data.message?.root_id || data.message?.thread_id) {
            console.log(`[feishu] 消息 ${data.message?.message_id} root=${data.message?.root_id ?? '-'} thread=${data.message?.thread_id ?? '-'} parent=${data.message?.parent_id ?? '-'}`);
          }
          if (data.message?.parent_id) {
            const quoted = await port.fetchQuoted(data.message.parent_id);
            if (quoted) {
              text = `${text}\n\n【用户引用的消息】\n${quoted}`;
            } else {
              // 明说而不是拿半句话硬跑：引用内容没拉到时，下游只会看到这一句话本身
              void port.notify('引用', '你引用的那条消息我没能拉取到内容（可能过久或权限不足），下面只按你这句话本身处理。如需分析引用内容，请粘成文字重发。');
            }
          }
          onMessage({
            chatId: data.message?.chat_id ?? '',
            text,
            mentioned: parsed.mentioned,
            sender: data.sender?.sender_id?.open_id ?? 'unknown',
            messageId: data.message?.message_id ?? '',
            quotedMessageId: data.message?.parent_id,
            rootId: data.message?.root_id,
            inThread,
          });
        }
        return { code: 0 };
      }) as (data: never) => Promise<unknown>;
    }

    ws.start({ eventDispatcher: new lark.EventDispatcher({}).register(handlers) });
    return port;
  }

  /**
   * 群路由钩子（daemon 注入）：按工单号/项目别名找绑定群。
   * 优先级：调用方显式指定的 chatId（回到消息来源群）> 本钩子（项目绑定群）> 默认主群。
   * 工单生命周期通知（阶段结果/卡点/验收问题）没有"来源消息"，全靠本钩子路由到项目群。
   */
  routeChat?: (ticketOrAlias: string) => string | undefined;
  /** 工单话题钩子（daemon 注入）：工单绑了话题就把它的卡片/进度投进话题（src/threads.ts） */
  routeThread?: (ticket: string) => string | undefined;

  private chatFor(ticketOrAlias: string, explicit?: ChatRef): string | undefined {
    return chatIdOf(explicit) ?? this.routeChat?.(ticketOrAlias);
  }

  /**
   * 投递目标：调用方给了来源（Origin）就回到来源——话题里问的答进话题；
   * 没给来源的是工单生命周期消息，按工单绑定的群 + 工单话题路由
   */
  private targetFor(ticketOrAlias: string, explicit?: ChatRef): { chatId?: string; rootId?: string } {
    if (explicit !== undefined) return { chatId: chatIdOf(explicit), rootId: rootIdOf(explicit) };
    return { chatId: this.routeChat?.(ticketOrAlias), rootId: this.routeThread?.(ticketOrAlias) };
  }

  /** 发到群或话题：有 rootId 走 reply + reply_in_thread（回到话题），否则 create 到群 */
  /**
   * 代会话发文件/图片（出件箱，见 src/outbox.ts）：先上传拿 key，再以 file/image 消息发到目标（话题就回话题）。
   * 单个失败不影响其余；返回发成功与失败的文件名供调用方通报
   */
  async sendFiles(ticketOrAlias: string, files: string[], to?: ChatRef): Promise<{ sent: string[]; failed: string[] }> {
    const target = this.targetFor(ticketOrAlias, to);
    const sent: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      const name = path.basename(f);
      try {
        // SDK 对上传接口把 data 拆开了直接返回 { file_key }（2026-09-10 实测），其他接口是 { data: {...} }——两种都认
        if (isImage(name)) {
          const res = (await this.client.im.image.create({
            data: { image_type: 'message', image: fs.createReadStream(f) },
          })) as { image_key?: string; data?: { image_key?: string } } | undefined;
          const key = res?.image_key ?? res?.data?.image_key;
          if (!key) throw new Error('上传未返回 image_key');
          await this.post('image', JSON.stringify({ image_key: key }), target);
        } else {
          const res = (await this.client.im.file.create({
            data: { file_type: imFileType(name), file_name: name, file: fs.createReadStream(f) },
          })) as { file_key?: string; data?: { file_key?: string } } | undefined;
          const key = res?.file_key ?? res?.data?.file_key;
          if (!key) throw new Error('上传未返回 file_key');
          await this.post('file', JSON.stringify({ file_key: key }), target);
        }
        sent.push(name);
      } catch (e) {
        console.warn(`[feishu] 发送文件失败 ${name}：${(e as Error).message.slice(0, 160)}`);
        failed.push(name);
      }
    }
    return { sent, failed };
  }

  private async post(msgType: string, content: string, to: { chatId?: string; rootId?: string }): Promise<string | undefined> {
    if (to.rootId) {
      try {
        const res = (await this.client.im.message.reply({
          path: { message_id: to.rootId },
          data: { msg_type: msgType, content, reply_in_thread: true },
        })) as { data?: { message_id?: string } } | undefined;
        return res?.data?.message_id;
      } catch (e) {
        // 话题根被删/过期：退回群主线，不能让一条消息发不出去
        console.warn(`[feishu] 话题回复失败，改发群主线：${(e as Error).message.slice(0, 120)}`);
      }
    }
    const res = (await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: to.chatId ?? this.cfg.chatId, msg_type: msgType, content },
    })) as { data?: { message_id?: string } } | undefined;
    return res?.data?.message_id;
  }

  /** 回调核心（纯逻辑，可单测）：按 key 归位 pending，返回更新后的卡片；未命中返回 null */
  handleCardAction(value: CardAction | undefined, formValue?: Record<string, string>): Record<string, unknown> | null {
    if (!value?.key) return null;
    const p = this.pending.get(value.key);
    if (!p) return null;
    this.pending.delete(value.key);
    const result = value.kind === 'gate' ? (value.decision ?? 'reject') : (value.answer ?? '');
    const note = formValue?.note?.trim() || undefined;
    p.resolve({ value: result, note });
    // 合并卡片：标记该项已答并重绘整卡，其余项的按钮必须保留
    if (p.group) {
      const item = p.group.items.find((i) => i.key === value.key);
      if (item) {
        item.answer = result;
        item.note = note;
      }
      return questionsCard(p.group.ticket, p.group.items);
    }
    return resolvedCard(p.resolvedTitle, p.contextBody, result, note);
  }

  private nextKey(prefix: string): string {
    return `${prefix}:${Date.now()}:${++this.seq}`;
  }

  /** 发送卡片，返回 message_id（用于后续原位更新） */
  private postCard(card: Record<string, unknown>, to?: ChatRef | { chatId?: string; rootId?: string }): Promise<string | undefined> {
    return this.post('interactive', JSON.stringify(card), asTarget(to));
  }

  /** 原位更新已发出的卡片（打字回答时用——回调窗口更新只在点按钮时可用） */
  private async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    try {
      await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
    } catch (e) {
      console.warn(`[feishu] 卡片更新失败（不影响回答已记录）：${(e as Error).message}`);
    }
  }

  /** 发送带表单的卡片；若该租户/客户端不支持表单则自动降级为纯按钮卡片 */
  private waitFor(
    key: string,
    resolvedTitle: string,
    contextBody: string,
    meta: {
      kind: 'answer' | 'gate';
      label: string;
      options?: string[];
      group?: QuestionGroup;
      ticket?: string;
      strictOptions?: boolean;
    },
  ): Promise<{ value: string; note?: string }> {
    return new Promise((resolve) => this.pending.set(key, { resolve, resolvedTitle, contextBody, ...meta }));
  }

  /** 当前待回答项；给出 ticket 则只列该工单的（供意图识别构建现场上下文） */
  pendingLabels(ticket?: string): string[] {
    return [...this.pending.values()].filter((p) => !ticket || p.ticket === ticket).map((p) => p.label);
  }

  /**
   * 用群里的一句话回答待确认卡片。
   * allowFreeText=false 时只接受明确表决/选项匹配，避免把指令误当成答案；
   * 支持 "Q2 不通过 页面报500" 形式指定目标并附带说明。
   */
  tryAnswerByText(text: string, allowFreeText = false, onlyTicket?: string): TextAnswerResult {
    // 工单话题里的话只可能在答这张单的卡：别让别的单的 Q1 抢答
    const entries = [...this.pending.entries()].filter(([, p]) => !onlyTicket || p.ticket === onlyTicket);
    if (!entries.length) return { status: 'none' };
    const labels = () => entries.map(([, p]) => p.label).join('、');
    const body0 = text.trim();

    // 「全部通过」「都无法验证」：一次答完所有待答项
    const batch = /^(全部|都|所有|all)\s*[:：]?\s*(.+)$/i.exec(body0);
    if (batch) {
      // 「全部通过，但是我还想…」：表决后跟一段明显是新诉求的长句，别塞进每一项的备注（2026-09-04 实测：
      // 一句新交互需求被灌进 6 个 Q 的补充说明还触发验收重跑）。拆出来交给上层提示开新单
      const { verdict: want, tail } = splitTrailingRequest(batch[2].trim());
      const done: string[] = [];
      const skipped: string[] = [];
      for (const [key, p] of entries) {
        const r = this.resolveOne(key, p, want, false);
        if (r) done.push(p.label);
        else skipped.push(p.label);
      }
      if (!done.length) {
        return { status: 'ambiguous', detail: `没有哪一项的选项匹配「${want}」（待回答：${labels()}）` };
      }
      return { status: 'resolved-batch', labels: done, answer: want, skipped, tail };
    }

    // 「Q1 Q3 通过」：指定一个或多个目标
    const idm = /^((?:Q\d+[\s,，、]*)+)[：:\s]+(.+)$/i.exec(body0);
    if (idm) {
      const ids = (idm[1].match(/Q\d+/gi) ?? []).map((s) => s.toUpperCase());
      const body = idm[2].trim();
      const hit = entries.filter(([, p]) => ids.includes(p.label.toUpperCase()));
      const missing = ids.filter((id) => !entries.some(([, p]) => p.label.toUpperCase() === id));
      if (!hit.length) return { status: 'ambiguous', detail: `当前没有待回答的 ${ids.join('、')}（待回答：${labels()}）` };
      const done: string[] = [];
      const skipped = [...missing];
      let note: string | undefined;
      let resolvedAnswer = body;
      for (const [key, p] of hit) {
        const r = this.resolveOne(key, p, body, allowFreeText);
        if (r) {
          done.push(p.label);
          note = r.note;
          resolvedAnswer = r.answer; // 选项匹配后的规范答案（剥掉附带说明）
        } else skipped.push(p.label);
      }
      if (!done.length) return { status: 'none' };
      return done.length === 1 && !skipped.length
        ? { status: 'resolved', label: done[0], answer: resolvedAnswer, note }
        : { status: 'resolved-batch', labels: done, answer: resolvedAnswer, skipped };
    }

    if (entries.length > 1) {
      return {
        status: 'ambiguous',
        detail: `有 ${entries.length} 项待回答（${labels()}）：请点卡片按钮，或用「${entries[0][1].label} 通过」指明，或用「全部通过」一次答完`,
      };
    }

    const [key, p] = entries[0];
    const r = this.resolveOne(key, p, body0, allowFreeText);
    return r ? { status: 'resolved', label: p.label, answer: r.answer, note: r.note } : { status: 'none' };
  }

  /** 把一句话解析成某一项的答案并归位；无法解析返回 null */
  private resolveOne(
    key: string,
    p: Pending,
    body: string,
    allowFreeText: boolean,
  ): { answer: string; note?: string } | null {
    let answer: string;
    let note: string | undefined;
    if (p.kind === 'gate') {
      if (APPROVE.test(body)) {
        answer = 'approve';
        note = body.replace(APPROVE, '').trim() || undefined;
      } else if (REJECT.test(body)) {
        answer = 'reject';
        note = body.replace(REJECT, '').trim() || undefined;
      } else return null;
    } else {
      const opt = p.options?.find((o) => body === o) ?? p.options?.find((o) => body.startsWith(o));
      if (opt) {
        answer = opt;
        note = body.slice(opt.length).trim() || undefined;
      } else if (allowFreeText && !p.strictOptions) {
        answer = body;
      } else return null;
    }
    this.pending.delete(key);
    p.resolve({ value: answer, note });
    if (p.group) {
      const item = p.group.items.find((i) => i.key === key);
      if (item) {
        item.answer = answer;
        item.note = note;
      }
      // 打字回答无回调窗口，主动原位更新卡片
      if (p.group.messageId) void this.patchCard(p.group.messageId, questionsCard(p.group.ticket, p.group.items));
    }
    return { answer, note };
  }

  /** 多个问题合并成一张卡片一次发出；每项被回答后原位更新，不再刷屏 */
  async askQuestions(ticket: string, questions: OpenQuestion[]): Promise<Answer[]> {
    const group: QuestionGroup = {
      ticket,
      items: questions.map((q) => ({ q, key: this.nextKey(`ans:${ticket}:${q.id}`) })),
    };
    const waits = group.items.map((it) =>
      this.waitFor(it.key, `${ticket} ${it.q.id} 已回答`, `**${it.q.question}**`, {
        kind: 'answer',
        label: it.q.id,
        options: it.q.options,
        group,
        ticket,
      }).then(({ value, note }) => ({ id: it.q.id, question: it.q.question, answer: value, note })),
    );
    group.messageId = await this.postCard(questionsCard(ticket, group.items), this.targetFor(ticket));
    return Promise.all(waits);
  }

  async confirmGate(
    ticket: string,
    gate: string,
    summary: string,
    concerns: string[],
    detail?: string,
  ): Promise<GateDecision> {
    const key = this.nextKey(`gate:${ticket}:${gate}`);
    const wait = this.waitFor(key, `${ticket} 卡点 ${gate} 已处理`, summary, { kind: 'gate', label: gate, ticket });
    await this.postCard(gateCard(ticket, gate, summary, concerns, key, detail), this.targetFor(ticket));
    const { value, note } = await wait;
    return { approved: value === 'approve', note };
  }

  async notify(ticket: string, message: string, to?: ChatRef): Promise<void> {
    await this.postText(ticket, message, to);
  }

  /**
   * 广播：工单绑了话题时主线与话题各一份（开工/收尾/上线/闭环/挂起这类别人也要看的）；
   * 主线那份点明详情在话题里——卡片都进了话题，只盯主线的人得知道去哪找
   */
  async broadcast(ticket: string, message: string): Promise<void> {
    const rootId = this.routeThread?.(ticket);
    if (!rootId) return this.notify(ticket, message);
    await Promise.all([
      this.post('text', JSON.stringify({ text: `[${ticket}] ${message}\n（卡片与详情在 ${ticket} 的话题里）` }), { chatId: this.routeChat?.(ticket) }),
      this.post('text', JSON.stringify({ text: `[${ticket}] ${message}` }), { rootId }),
    ]);
  }

  /**
   * 开工单话题：在主线发一条根消息并返回它的 message_id；此后该工单的卡片/进度都 reply_in_thread 到它。
   * 第一条话题回复才真正建出话题（飞书没有「空话题」）
   */
  async openTicketThread(ticket: string, headline: string): Promise<string | undefined> {
    return this.post('text', JSON.stringify({ text: `[${ticket}] ${headline}` }), { chatId: this.routeChat?.(ticket) });
  }

  /** 发纯文本，返回 message_id（结果卡要记「这条消息 ↔ 哪次会话」，引用它就能精确续聊） */
  private postText(ticket: string, message: string, to?: ChatRef): Promise<string | undefined> {
    return this.post('text', JSON.stringify({ text: `[${ticket}] ${message}` }), this.targetFor(ticket, to));
  }

  /** 结构化报告（验收 AC 结果表等）：复用结果卡的长文渲染 */
  async sendReport(ticket: string, title: string, markdown: string): Promise<void> {
    await this.sendResult(`${title} · ${ticket}`, markdown, undefined, this.chatFor(ticket));
  }

  /**
   * 拉取被引用消息的内容并展开成文本；父消息是合并转发时含全部子消息。
   * 可下载的图片落到 data/quoted/，文本里替换成文件路径（执行会话用 Read 工具就能看图）。
   * 失败返回 null（缺 im:message.group_msg 权限 / 消息过久），由调用方决定怎么向人交代。
   */
  async fetchQuoted(messageId: string): Promise<string | null> {
    try {
      const res = (await this.client.im.message.get({ path: { message_id: messageId } })) as {
        data?: { items?: QuotedItem[] };
      };
      const { text, resources } = renderQuotedItems(res?.data?.items ?? []);
      let out = text;
      for (const ref of resources) {
        const saved = await this.downloadQuotedResource(ref);
        const what = ref.kind === 'image' ? '图片' : '文件';
        out = out.replace(
          ref.marker,
          saved
            ? `[${what}已保存：${saved}——文本/图片/PDF 可用 Read 工具查看，其他格式可用 Bash 处理]`
            : `[${what}，下载失败未解析]`,
        );
      }
      return out || null;
    } catch {
      return null;
    }
  }

  /**
   * 下载引用的图片/文件到 data/quoted/（图片按 Content-Type 定扩展名，文件保留原名）；
   * 顺手清理 7 天前的旧资源。失败返回 null
   */
  private async downloadQuotedResource(ref: QuotedResourceRef): Promise<string | null> {
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: ref.kind },
        path: { message_id: ref.messageId, file_key: ref.fileKey },
      });
      const quoted = quotedDir();
      fs.mkdirSync(quoted, { recursive: true });
      for (const f of fs.readdirSync(quoted)) {
        const fp = path.join(quoted, f);
        if (Date.now() - fs.statSync(fp).mtimeMs > 7 * 24 * 3600_000) fs.rmSync(fp, { force: true });
      }
      // file_key 可作文件名（字母数字下划线连字符），复用它天然去重同资源多次引用；
      // 文件消息再拼上原始文件名，扩展名跟着原名走（Read/Bash 都认得出格式）
      const keyPart = ref.fileKey.replace(/[^\w-]/g, '_');
      let name: string;
      if (ref.kind === 'image') {
        const ct = String((resp.headers as Record<string, unknown>)?.['content-type'] ?? '');
        const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.png';
        name = `${keyPart}${ext}`;
      } else {
        const safe = (ref.name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-80);
        name = `${keyPart.slice(0, 16)}_${safe}`;
      }
      const file = path.join(quoted, name);
      await resp.writeFile(file);
      return file;
    } catch {
      return null;
    }
  }

  /** 发送单次执行结果：短的走消息，长的走卡片（消息读长文很难受） */
  async sendResult(title: string, body: string, footer?: string, to?: ChatRef): Promise<string | undefined> {
    if (body.length <= 600) return this.postText(title, `${body}${footer ? `\n\n${footer}` : ''}`, to);
    const clipped = body.length > 8000 ? body.slice(0, 8000) + '\n\n…（输出过长已截断）' : body;
    return this.postCard(resultCard(title, clipped, footer), this.targetFor(title, to));
  }

  /** 发送运行面板卡片（/dashboard 指令） */
  async sendDashboard(config: string, runtime: string, tickets: string, to?: ChatRef): Promise<void> {
    await this.postCard(dashboardCard(config, runtime, tickets), to);
  }

  /** 发送状态卡片（/status 指令） */
  async sendStatus(ticket: string, cursor: string, extra: string, timelineMd: string, to?: ChatRef): Promise<void> {
    await this.postCard(statusCard(ticket, cursor, extra, timelineMd), this.targetFor(ticket, to));
  }

  /** 让人从候选里选一个（识别不确定时用，比"没听懂"友好） */
  async chooseOption(ticket: string, question: string, options: string[], to?: ChatRef): Promise<string> {
    const key = this.nextKey(`choose:${ticket}`);
    const wait = this.waitFor(key, `${ticket} 已选择`, question, {
      kind: 'answer',
      label: '选择',
      options,
      ticket,
      strictOptions: true,
    });
    await this.postCard(chooseCard(ticket, question, options, key), this.targetFor(ticket, to));
    return (await wait).value;
  }

  /** 破坏性指令确认：返回是否执行 */
  async confirmCommand(ticket: string, what: string, to?: ChatRef): Promise<boolean> {
    const key = this.nextKey(`cmd:${ticket}`);
    const wait = this.waitFor(key, `${ticket} 操作已处理`, what, { kind: 'gate', label: '确认操作' });
    await this.postCard(confirmCard(ticket, what, key), this.targetFor(ticket, to));
    return (await wait).value === 'approve';
  }

  close(): void {
    // node-sdk WSClient 暂无公开 stop API；进程退出即断开
    this.ws = null;
  }
}

/** 引用/合并转发展开用的消息项（im.message.get 返回的 items 形状子集） */
export interface QuotedItem {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
}

/** 待下载的资源引用（图片/文件）：marker 是先占进文本的位置，下载后原地替换成文件路径 */
export interface QuotedResourceRef {
  messageId: string;
  fileKey: string;
  marker: string;
  /** 资源接口的 type 参数：图片 image，文件/音视频 file */
  kind: 'image' | 'file';
  /** 文件消息自带的原始文件名（含扩展名），落盘时保留 */
  name?: string;
}

/** 引用内容注入指令文本的上限：够业务对话用，防止超长转发把分类与执行提示词撑爆 */
const QUOTE_CAP = 3000;

/** 引用图片的落盘目录（data/ 已 gitignore；下载时顺手清 7 天前的旧图） */
const quotedDir = (): string => path.join(dataDir(), 'quoted');

/** 合并转发子消息里的资源：飞书资源接口明确不开放（错误码 234043），只能占位说明 */
const MF_RES_PLACEHOLDER = (what: string): string =>
  `[${what}，未解析——合并转发内的${what}飞书不开放下载，如需分析请单独发]`;

/**
 * 从「表决 + 转折 + 新诉求」里把表决摘出来（纯逻辑，可单测）。
 * 只在「表决词很短 + 转折词 + 后半段明显更长」时才拆，避免误伤「通过，因为查过了」这种给表决本身的补充。
 * 返回 tail 时，上层应把它当作可能的新工单来提示，而不是当补充说明灌进每一项。
 */
export function splitTrailingRequest(text: string): { verdict: string; tail?: string } {
  const m = /^(.{1,12}?)\s*[，,。;；]?\s*(但是|但|不过|另外|另|顺便|额外|还有|以及|同时|接下来|下一步|我还想|我想再|再帮我)\s*(.{12,})$/s.exec(text.trim());
  if (!m) return { verdict: text.trim() };
  const verdict = m[1].trim().replace(/[，,。;；]$/, '');
  return { verdict, tail: `${m[2]}${m[3]}`.trim() };
}

/**
 * 卡片 JSON → 可读文字（纯逻辑，可单测）。三种形状都要认：
 * - 发出时的 v1 卡（header/elements，文字在 `content`）与 v2 卡（schema 2.0 的 body.elements）；
 * - im.message.get 拉回来的卡（2026-09-04 真机实测）：被折成 post 形状 `{title, elements:[[{tag:'text', text:'…'}]]}`，文字在 `text`。
 * 按文档顺序收集 title / content / text 三种键的字串，原样保留。
 */
export function renderCardText(content: string | undefined): string {
  if (!content) return '';
  let card: unknown;
  try {
    card = JSON.parse(content);
  } catch {
    return '';
  }
  const out: string[] = [];
  const walk = (n: unknown, key?: string): void => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x));
    if (!n || typeof n !== 'object') {
      if (typeof n === 'string' && (key === 'content' || key === 'text' || key === 'title') && n.trim()) out.push(n.trim());
      return;
    }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === 'url' || k === 'value' || k === 'key' || k === 'template' || k === 'tag' || k === 'type') continue;
      walk(v, k);
    }
  };
  walk(card);
  return [...new Set(out)].join('\n');
}

/**
 * 展开引用/合并转发的消息项为可读文本（纯逻辑，可单测）。
 * 合并转发的父项只有占位标题（"Merged and Forwarded Message"），跳过。
 * 可下载的资源（引用的图片/文件消息、群内富文本的图）登记进 resources，由调用方下载后替换 marker；
 * 拿不到的一律占位标注——诚实说明"这部分我没看到"，不能静默吞掉。
 */
export function renderQuotedItems(items: QuotedItem[]): { text: string; resources: QuotedResourceRef[] } {
  // 合并转发的子消息资源不可下载（234043）；其余场景（引用图片/文件消息、群内富文本）可下载
  const inMergeForward = items[0]?.msg_type === 'merge_forward';
  const resources: QuotedResourceRef[] = [];
  const mark = (
    kind: 'image' | 'file',
    what: string,
    messageId: string | undefined,
    fileKey: string | undefined,
    name?: string,
  ): string => {
    if (inMergeForward || !messageId || !fileKey) return MF_RES_PLACEHOLDER(what);
    const marker = `[${what}#${resources.length + 1}]`;
    resources.push({ messageId, fileKey, marker, kind, name });
    return marker;
  };
  const lines: string[] = [];
  for (const it of items) {
    const c = it.body?.content;
    if (it.msg_type === 'text') {
      try {
        const t = (JSON.parse(c ?? '') as { text?: string }).text?.trim();
        if (t) lines.push(t);
      } catch {
        /* 坏行跳过 */
      }
    } else if (it.msg_type === 'post') {
      lines.push(renderPost(c, (key) => mark('image', '图片', it.message_id, key)));
    } else if (it.msg_type === 'image') {
      try {
        const key = (JSON.parse(c ?? '') as { image_key?: string }).image_key;
        lines.push(mark('image', '图片', it.message_id, key));
      } catch {
        lines.push(MF_RES_PLACEHOLDER('图片'));
      }
    } else if (it.msg_type === 'file') {
      try {
        const f = JSON.parse(c ?? '') as { file_key?: string; file_name?: string };
        lines.push(mark('file', '文件', it.message_id, f.file_key, f.file_name));
      } catch {
        lines.push(MF_RES_PLACEHOLDER('文件'));
      }
    } else if (it.msg_type === 'merge_forward') {
      /* 父项占位标题，子消息随后逐条出现 */
    } else if (it.msg_type === 'interactive') {
      // 被引用的是卡片（多半是机器人自己发的问题卡/结果卡）：把卡片 JSON 里的文字抽出来，
      // 否则人引用一张问题卡说「这是原来的回复」，会话只拿到「interactive 消息，未解析」（2026-09-04 实测）
      const t = renderCardText(c);
      lines.push(t ? `【引用的卡片内容】\n${t}` : '[卡片消息，无可读文字]');
    } else {
      lines.push(`[${it.msg_type ?? '未知类型'}消息，未解析]`);
    }
  }
  const joined = lines.filter(Boolean).join('\n');
  // 截断只砍文本尾巴：marker 若被截掉，对应 resources 项替换不到也无害（replace 落空）
  const text = joined.length > QUOTE_CAP ? `${joined.slice(0, QUOTE_CAP)}\n…（引用内容过长已截断）` : joined;
  return { text, resources };
}

/** 富文本消息（post）拍平成纯文本；内嵌图片经 imgMark 决定是登记下载还是占位 */
function renderPost(content: string | undefined, imgMark: (key?: string) => string): string {
  try {
    const p = JSON.parse(content ?? '') as {
      title?: string;
      content?: Array<Array<{ tag?: string; text?: string; image_key?: string }>>;
    };
    const runs: string[] = [];
    if (p.title?.trim()) runs.push(p.title.trim());
    for (const para of p.content ?? []) {
      const line = para
        .map((r) => (r.tag === 'text' || r.tag === 'a' ? (r.text ?? '') : r.tag === 'img' ? imgMark(r.image_key) : ''))
        .join('');
      if (line.trim()) runs.push(line.trim());
    }
    return runs.join('\n');
  } catch {
    return '[富文本，解析失败]';
  }
}

/** 提取群消息文本与是否 @ 了机器人；去掉 @ 占位符 */
export function parseMessageText(
  content: string | undefined,
  messageType?: string,
): { text: string; mentioned: boolean } | null {
  if (!content || (messageType && messageType !== 'text' && messageType !== 'post')) return null;
  try {
    // 富文本（post）优先按结构化 runs 解析——它的 .text 兜底字段里飞书会留 <p></p> 之类的
    // 段落标签，粘在斜杠命令上会把 /new 变成 /new<p></p> 判成没听懂（实测 2026-09-02，用户被迫重打）
    if (messageType === 'post') {
      const p = JSON.parse(content) as {
        title?: string;
        content?: Array<Array<{ tag?: string; text?: string }>>;
        text?: string;
      };
      if (Array.isArray(p.content)) {
        let mentioned = false;
        const lines: string[] = [];
        if (p.title?.trim()) lines.push(p.title.trim());
        for (const para of p.content) {
          const line = para
            .map((r) => {
              if (r.tag === 'at') {
                mentioned = true;
                return '';
              }
              return r.tag === 'text' || r.tag === 'a' ? (r.text ?? '') : '';
            })
            .join('');
          if (line.trim()) lines.push(line.trim());
        }
        const raw = lines.join(' ');
        if (/@_user_\d+/.test(raw)) mentioned = true;
        const cleaned = raw.replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim();
        return cleaned ? { text: cleaned, mentioned } : null;
      }
    }
    const parsed = JSON.parse(content) as { text?: string };
    let raw = parsed.text ?? '';
    // post 的平铺兜底：只清段落级标签（<p>/<br>）。不做全量尖括号清洗——消息里常有代码泛型（Array<string>）
    if (messageType === 'post') raw = raw.replace(/<\/?p\s*>/gi, ' ').replace(/<br\s*\/?>/gi, ' ');
    const mentioned = /@_user_\d+/.test(raw);
    const cleaned = raw.replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim();
    return cleaned ? { text: cleaned, mentioned } : null;
  } catch {
    return null;
  }
}

export function feishuConfigFromEnv(): FeishuConfig {
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHAT_ID } = process.env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_CHAT_ID) {
    throw new Error('FeishuPort 需要环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
  }
  return { appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, chatId: FEISHU_CHAT_ID };
}
