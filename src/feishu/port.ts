import * as lark from '@larksuiteoapi/node-sdk';
import type { Answer } from '../backfill.js';
import type { GateDecision, InteractionPort } from '../ports.js';
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
}

const APPROVE = /^(通过|同意|批准|可以|没问题|ok|approve|yes|y)/i;
const REJECT = /^(驳回|不通过|拒绝|否决|reject|no|n)/i;

export type TextAnswerResult =
  | { status: 'resolved'; label: string; answer: string; note?: string }
  | { status: 'resolved-batch'; labels: string[]; answer: string; skipped: string[] }
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
        message?: { chat_id?: string; content?: string; message_id?: string; message_type?: string };
        sender?: { sender_id?: { open_id?: string } };
      }) => {
        const parsed = parseMessageText(data?.message?.content, data?.message?.message_type);
        if (parsed) {
          onMessage({
            chatId: data.message?.chat_id ?? '',
            text: parsed.text,
            mentioned: parsed.mentioned,
            sender: data.sender?.sender_id?.open_id ?? 'unknown',
            messageId: data.message?.message_id ?? '',
          });
        }
        return { code: 0 };
      }) as (data: never) => Promise<unknown>;
    }

    ws.start({ eventDispatcher: new lark.EventDispatcher({}).register(handlers) });
    return port;
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
  private async postCard(card: Record<string, unknown>, chatId?: string): Promise<string | undefined> {
    const res = (await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId ?? this.cfg.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })) as { data?: { message_id?: string } } | undefined;
    return res?.data?.message_id;
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
    meta: { kind: 'answer' | 'gate'; label: string; options?: string[]; group?: QuestionGroup; ticket?: string },
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
  tryAnswerByText(text: string, allowFreeText = false): TextAnswerResult {
    const entries = [...this.pending.entries()];
    if (!entries.length) return { status: 'none' };
    const labels = () => entries.map(([, p]) => p.label).join('、');
    const body0 = text.trim();

    // 「全部通过」「都无法验证」：一次答完所有待答项
    const batch = /^(全部|都|所有|all)\s*[:：]?\s*(.+)$/i.exec(body0);
    if (batch) {
      const want = batch[2].trim();
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
      return { status: 'resolved-batch', labels: done, answer: want, skipped };
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
      } else if (allowFreeText) {
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
    group.messageId = await this.postCard(questionsCard(ticket, group.items));
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
    await this.postCard(gateCard(ticket, gate, summary, concerns, key, detail));
    const { value, note } = await wait;
    return { approved: value === 'approve', note };
  }

  async notify(ticket: string, message: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.cfg.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: `[${ticket}] ${message}` }),
      },
    });
  }

  /** 发送单次执行结果：短的走消息，长的走卡片（消息读长文很难受） */
  async sendResult(title: string, body: string, footer?: string): Promise<void> {
    if (body.length <= 600) {
      await this.notify(title, `${body}${footer ? `\n\n${footer}` : ''}`);
      return;
    }
    const clipped = body.length > 8000 ? body.slice(0, 8000) + '\n\n…（输出过长已截断）' : body;
    await this.postCard(resultCard(title, clipped, footer));
  }

  /** 发送运行面板卡片（/dashboard 指令） */
  async sendDashboard(config: string, runtime: string, tickets: string): Promise<void> {
    await this.postCard(dashboardCard(config, runtime, tickets));
  }

  /** 发送状态卡片（/status 指令） */
  async sendStatus(ticket: string, cursor: string, extra: string, timelineMd: string): Promise<void> {
    await this.postCard(statusCard(ticket, cursor, extra, timelineMd));
  }

  /** 让人从候选里选一个（识别不确定时用，比"没听懂"友好） */
  async chooseOption(ticket: string, question: string, options: string[]): Promise<string> {
    const key = this.nextKey(`choose:${ticket}`);
    const wait = this.waitFor(key, `${ticket} 已选择`, question, { kind: 'answer', label: '选择', options, ticket });
    await this.postCard(chooseCard(ticket, question, options, key));
    return (await wait).value;
  }

  /** 破坏性指令确认：返回是否执行 */
  async confirmCommand(ticket: string, what: string): Promise<boolean> {
    const key = this.nextKey(`cmd:${ticket}`);
    const wait = this.waitFor(key, `${ticket} 操作已处理`, what, { kind: 'gate', label: '确认操作' });
    await this.postCard(confirmCard(ticket, what, key));
    return (await wait).value === 'approve';
  }

  close(): void {
    // node-sdk WSClient 暂无公开 stop API；进程退出即断开
    this.ws = null;
  }
}

/** 提取群消息文本与是否 @ 了机器人；去掉 @ 占位符 */
export function parseMessageText(
  content: string | undefined,
  messageType?: string,
): { text: string; mentioned: boolean } | null {
  if (!content || (messageType && messageType !== 'text' && messageType !== 'post')) return null;
  try {
    const parsed = JSON.parse(content) as { text?: string };
    const raw = parsed.text ?? '';
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
