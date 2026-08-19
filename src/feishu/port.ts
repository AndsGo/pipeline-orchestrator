import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
        message?: {
          chat_id?: string;
          content?: string;
          message_id?: string;
          message_type?: string;
          /** 引用回复时带上被引用消息的 ID——内容要另调 API 拉（需 im:message.group_msg 权限） */
          parent_id?: string;
        };
        sender?: { sender_id?: { open_id?: string } };
      }) => {
        const parsed = parseMessageText(data?.message?.content, data?.message?.message_type);
        if (parsed) {
          let text = parsed.text;
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

  /** 结构化报告（验收 AC 结果表等）：复用结果卡的长文渲染 */
  async sendReport(ticket: string, title: string, markdown: string): Promise<void> {
    await this.sendResult(`${title} · ${ticket}`, markdown);
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
      const { text, images } = renderQuotedItems(res?.data?.items ?? []);
      let out = text;
      for (const ref of images) {
        const saved = await this.downloadQuotedImage(ref);
        out = out.replace(ref.marker, saved ? `[图片已保存：${saved}——请用 Read 工具查看]` : '[图片，下载失败未解析]');
      }
      return out || null;
    } catch {
      return null;
    }
  }

  /** 下载引用图片到 data/quoted/（按 Content-Type 定扩展名）；顺手清理 7 天前的旧图。失败返回 null */
  private async downloadQuotedImage(ref: QuotedImageRef): Promise<string | null> {
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: ref.messageId, file_key: ref.fileKey },
      });
      fs.mkdirSync(QUOTED_DIR, { recursive: true });
      for (const f of fs.readdirSync(QUOTED_DIR)) {
        const fp = path.join(QUOTED_DIR, f);
        if (Date.now() - fs.statSync(fp).mtimeMs > 7 * 24 * 3600_000) fs.rmSync(fp, { force: true });
      }
      const ct = String((resp.headers as Record<string, unknown>)?.['content-type'] ?? '');
      const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.png';
      // file_key 可作文件名（字母数字下划线连字符），复用它天然去重同图多次引用
      const file = path.join(QUOTED_DIR, `${ref.fileKey.replace(/[^\w-]/g, '_')}${ext}`);
      await resp.writeFile(file);
      return file;
    } catch {
      return null;
    }
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

/** 引用/合并转发展开用的消息项（im.message.get 返回的 items 形状子集） */
export interface QuotedItem {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
}

/** 待下载的图片引用：marker 是先占进文本的位置，下载后原地替换成文件路径 */
export interface QuotedImageRef {
  messageId: string;
  fileKey: string;
  marker: string;
}

/** 引用内容注入指令文本的上限：够业务对话用，防止超长转发把分类与执行提示词撑爆 */
const QUOTE_CAP = 3000;

/** 引用图片的落盘目录（data/ 已 gitignore；下载时顺手清 7 天前的旧图） */
const QUOTED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/quoted');

/** 合并转发子消息里的图片：飞书资源接口明确不开放（错误码 234043），只能占位说明 */
const MF_IMG_PLACEHOLDER = '[图片，未解析——合并转发内的图片飞书不开放下载，如需分析请单独发图]';

/**
 * 展开引用/合并转发的消息项为可读文本（纯逻辑，可单测）。
 * 合并转发的父项只有占位标题（"Merged and Forwarded Message"），跳过。
 * 可下载的图片（引用的图片消息/群内富文本的图）登记进 images，由调用方下载后替换 marker；
 * 拿不到的一律占位标注——诚实说明"这部分我没看到"，不能静默吞掉。
 */
export function renderQuotedItems(items: QuotedItem[]): { text: string; images: QuotedImageRef[] } {
  // 合并转发的子消息资源不可下载（234043）；其余场景（引用图片消息、群内富文本）可下载
  const inMergeForward = items[0]?.msg_type === 'merge_forward';
  const images: QuotedImageRef[] = [];
  const imgMark = (messageId: string | undefined, fileKey: string | undefined): string => {
    if (inMergeForward || !messageId || !fileKey) return MF_IMG_PLACEHOLDER;
    const marker = `[图片#${images.length + 1}]`;
    images.push({ messageId, fileKey, marker });
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
      lines.push(renderPost(c, (key) => imgMark(it.message_id, key)));
    } else if (it.msg_type === 'image') {
      try {
        const key = (JSON.parse(c ?? '') as { image_key?: string }).image_key;
        lines.push(imgMark(it.message_id, key));
      } catch {
        lines.push(MF_IMG_PLACEHOLDER);
      }
    } else if (it.msg_type === 'merge_forward') {
      /* 父项占位标题，子消息随后逐条出现 */
    } else {
      lines.push(`[${it.msg_type ?? '未知类型'}消息，未解析]`);
    }
  }
  const joined = lines.filter(Boolean).join('\n');
  // 截断只砍文本尾巴：marker 若被截掉，对应 images 项替换不到也无害（replace 落空）
  const text = joined.length > QUOTE_CAP ? `${joined.slice(0, QUOTE_CAP)}\n…（引用内容过长已截断）` : joined;
  return { text, images };
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
