import type { OpenQuestion } from '../types.js';
import { GATE_CN } from '../voice.js';

/**
 * 飞书互动卡片构建器（纯函数，可单测）。
 * 交互契约：按钮 value = { kind, key, answer|decision }；表单输入 name='note' 经 form_value 回传。
 * 所有需要人回答的卡片都带自由输入框——人不能只有"点按钮"这一种表达方式。
 */

export interface CardAction {
  kind: 'answer' | 'gate';
  key: string;
  answer?: string;
  decision?: 'approve' | 'reject';
}

function header(title: string, template: string): Record<string, unknown> {
  return { title: { tag: 'plain_text', content: title }, template };
}

function md(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function button(text: string, type: 'primary' | 'default' | 'danger', value: CardAction): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value: value as unknown as Record<string, unknown>,
  };
}

/**
 * 自由输入的提示。
 * 注意：不要用 form/input 组件——实测该租户的卡片版本会把表单容器静默渲染为空
 * （API 接受、按钮和输入框全部消失），人反而无法回答。自由输入走群消息通道。
 */
function typeHint(example: string): Record<string, unknown> {
  return {
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `也可直接在群里 @我 打字回答，例：${example}` }],
  };
}

/** 一个问题的选项按钮。无选项时兜底两个——回答者必须始终拥有否决权 */
function optionButtons(q: OpenQuestion, key: string): Record<string, unknown>[] {
  return q.options?.length
    ? q.options.map((o) =>
        button(o.length > 30 ? o.slice(0, 30) + '…' : o, o === q.recommended ? 'primary' : 'default', {
          kind: 'answer',
          key,
          answer: o,
        }),
      )
    : [
        button('采纳推荐', 'primary', { kind: 'answer', key, answer: q.recommended }),
        button('不采纳（我来说明）', 'default', { kind: 'answer', key, answer: `不采纳推荐（${q.recommended}）` }),
      ];
}

export interface QuestionItem {
  q: OpenQuestion;
  key: string;
  answer?: string;
  note?: string;
}

/**
 * 待确认卡片：多个问题合并成一张卡（每题一组按钮），已回答的项就地变成 ✅ 记录。
 * 8 个验收项刷 8 张卡是灾难；合并成一张、原位更新才是清单该有的样子。
 */
export function questionsCard(ticket: string, items: QuestionItem[]): Record<string, unknown> {
  const multi = items.length > 1;
  const left = items.filter((i) => !i.answer);
  const title = multi ? `${ticket} 待确认 ${items.length} 项（待回答 ${left.length}）` : `${ticket} 待确认 ${items[0].q.id}`;
  const elements: Record<string, unknown>[] = [];

  items.forEach((it, idx) => {
    if (idx > 0) elements.push({ tag: 'hr' });
    elements.push(md(`**${it.q.id}. ${it.q.question}**`));
    const why = multi && it.q.why.length > 200 ? it.q.why.slice(0, 200) + '…' : it.q.why;
    elements.push(md(`**推荐：**${it.q.recommended}\n**理由：**${why}`));
    if (it.answer) {
      elements.push(md(`✅ 已回答：**${it.answer}**${it.note ? `（补充：${it.note}）` : ''}`));
    } else {
      elements.push({ tag: 'action', actions: optionButtons(it.q, it.key) });
    }
  });

  const first = left[0] ?? items[0];
  const example = multi
    ? `「${first.q.id} 不通过 实际是…」；全部一致可说「全部通过」`
    : first.q.options?.length
      ? `「${first.q.id} ${first.q.options[first.q.options.length - 1]} 实际情况是…」`
      : `「${first.q.id} 我的答案是…」`;
  if (left.length) elements.push(typeHint(example));

  return {
    config: { wide_screen_mode: true },
    header: header(title, left.length ? 'blue' : 'green'),
    elements,
  };
}

/** 单问题卡片（questionsCard 的便捷形式） */
export function questionCard(ticket: string, q: OpenQuestion, key: string): Record<string, unknown> {
  return questionsCard(ticket, [{ q, key }]);
}

/** 人工卡点卡片：通过 / 驳回（驳回原因可打字补充） */
export function gateCard(
  ticket: string,
  gate: string,
  summary: string,
  concerns: string[],
  key: string,
  detail?: string,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [md(summary)];
  // 决策材料（AC 清单 / 任务拆分）直接摊在卡上——审批人不该为了看清要批什么去开 IDE
  if (detail?.trim()) elements.push({ tag: 'hr' }, md(detail));
  if (concerns.length) elements.push(md(`**concerns：**\n${concerns.map((c) => `- ${c}`).join('\n')}`));
  elements.push({
    tag: 'action',
    actions: [
      button('通过', 'primary', { kind: 'gate', key, decision: 'approve' }),
      button('驳回', 'danger', { kind: 'gate', key, decision: 'reject' }),
    ],
  });
  elements.push(typeHint('「驳回 计划漏了限流」——理由会直接驱动重跑'));
  // 卡点名用业务叫法：`prd-confirm` 对审批人不是信息，「需求确认」才是（英文名留括号里，研发对得上事件流）
  const gateLabel = GATE_CN[gate] ? `${GATE_CN[gate]}（${gate}）` : gate;
  return { config: { wide_screen_mode: true }, header: header(`${ticket} 卡点：${gateLabel}`, 'orange'), elements };
}

/** 点击后的替换卡片：保留原始上下文 + 结果 + 人的补充说明 */
export function resolvedCard(title: string, context: string, result: string, note?: string): Record<string, unknown> {
  const body = [context, '---', `结果：**${result}**`];
  if (note?.trim()) body.push(`补充说明：${note.trim()}`);
  return {
    config: { wide_screen_mode: true },
    header: header(title, 'green'),
    elements: [md(body.join('\n\n'))],
  };
}

/** 运行面板：常用链接 + 运行情况 + 工单一览 */
export function dashboardCard(config: string, runtime: string, tickets: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: header('流水线运行面板', 'turquoise'),
    elements: [
      md(`**配置与入口**\n${config}`),
      { tag: 'hr' },
      md(`**运行情况**\n${runtime}`),
      { tag: 'hr' },
      md(`**工单**\n${tickets}`),
      { tag: 'note', elements: [{ tag: 'plain_text', content: '/status <工单号> 看单个工单的时间线　/help 看全部指令' }] },
    ],
  };
}

/** 工单状态卡片：时间线 + 当前节点 */
export function statusCard(ticket: string, cursor: string, extra: string, timelineMd: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: header(`${ticket} 状态`, 'turquoise'),
    elements: [md(`**当前节点：** ${cursor}\n${extra}`), { tag: 'hr' }, md(timelineMd)],
  };
}

/** 单次执行的结果卡片 */
export function resultCard(title: string, body: string, footer?: string): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [md(body)];
  if (footer) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] });
  return { config: { wide_screen_mode: true }, header: header(title, 'turquoise'), elements };
}

/** 候选选择卡片：识别不确定时不猜，把 2-3 个候选交给人点 */
export function chooseCard(ticket: string, question: string, options: string[], key: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: header(`${ticket} 请确认你的意思`, 'orange'),
    elements: [
      md(question),
      {
        tag: 'action',
        actions: options.map((o, i) =>
          button(o.length > 30 ? o.slice(0, 30) + '…' : o, i === 0 ? 'primary' : 'default', {
            kind: 'answer',
            key,
            answer: o,
          }),
        ),
      },
    ],
  };
}

/** 命令确认卡片（破坏性 NL 指令先确认再执行） */
export function confirmCard(ticket: string, what: string, key: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: header(`${ticket} 请确认操作`, 'orange'),
    elements: [
      md(what),
      {
        tag: 'action',
        actions: [
          button('确认执行', 'primary', { kind: 'gate', key, decision: 'approve' }),
          button('取消', 'default', { kind: 'gate', key, decision: 'reject' }),
        ],
      },
    ],
  };
}
