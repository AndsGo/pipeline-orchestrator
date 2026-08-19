import { describe, expect, it } from 'vitest';
import { gateCard, questionCard, statusCard, type CardAction } from '../feishu/card.js';
import { FeishuPort, parseMessageText, renderQuotedItems, type QuotedItem } from '../feishu/port.js';
import type { OpenQuestion } from '../types.js';

const q: OpenQuestion = {
  id: 'Q1',
  question: '撤销策略？',
  options: ['不做单独撤销', '支持单 Key 撤销'],
  recommended: '不做单独撤销',
  why: '最小范围',
};

type El = Record<string, unknown>;

function buttonsOf(card: Record<string, unknown>): El[] {
  const action = (card.elements as El[]).find((e) => e.tag === 'action');
  return action ? (action.actions as El[]) : [];
}

function actionsOf(card: Record<string, unknown>): CardAction[] {
  return buttonsOf(card).map((b) => b.value as CardAction);
}

describe('卡片构建器', () => {
  it('问题卡片：选项按钮直挂 action（不用 form/input——实测该租户会静默渲染为空）', () => {
    const card = questionCard('T-1', q, 'k1');
    // 卡片里不得出现 form / input 组件
    expect(JSON.stringify(card)).not.toContain('"form"');
    expect(JSON.stringify(card)).not.toContain('"input"');
    const buttons = buttonsOf(card);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].type).toBe('primary'); // 推荐项高亮
    expect(buttons[1].type).toBe('default');
    expect(actionsOf(card)[0]).toMatchObject({ kind: 'answer', key: 'k1', answer: '不做单独撤销' });
  });

  it('卡片附打字回答提示（自由输入的通道）', () => {
    expect(JSON.stringify(questionCard('T-1', q, 'k1'))).toContain('打字回答');
    expect(JSON.stringify(gateCard('T-1', 'g', 's', [], 'k'))).toContain('打字回答');
  });

  it('无 options 的问题：渲染「采纳推荐/不采纳」两按钮，绝不只给一个（真机缺陷回归）', () => {
    const noOpt: OpenQuestion = { id: 'Q9', question: 'x?', recommended: '通过（前提：503 命中限流日志）', why: 'w' };
    const values = actionsOf(questionCard('T-1', noOpt, 'k9'));
    expect(values).toHaveLength(2);
    expect(values[0].answer).toBe('通过（前提：503 命中限流日志）');
    expect(values[1].answer).toContain('不采纳推荐');
  });

  it('卡点卡片：通过/驳回两按钮，concerns 渲染进正文', () => {
    const card = gateCard('T-1', 'plan-approval', '摘要', ['c1'], 'k2');
    expect(actionsOf(card)).toEqual([
      { kind: 'gate', key: 'k2', decision: 'approve' },
      { kind: 'gate', key: 'k2', decision: 'reject' },
    ]);
    expect(JSON.stringify(card)).toContain('c1');
  });

  it('状态卡片渲染当前节点与时间线', () => {
    const c = statusCard('T-1', 'review', '**通道：** full', '▶️ `08-13 10:00` 阶段 plan 开始');
    const s = JSON.stringify(c);
    expect(s).toContain('review');
    expect(s).toContain('阶段 plan 开始');
  });
});

describe('FeishuPort 回调路由（不触网）', () => {
  function portWithSpy(): { port: FeishuPort; sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    const fakeClient = {
      im: {
        message: {
          create: async (req: Record<string, unknown>) => {
            sent.push(req);
            return {};
          },
        },
      },
    };
    const port = new FeishuPort(fakeClient as never, null, { appId: 'a', appSecret: 's', chatId: 'c' });
    return { port, sent };
  }

  const cardOf = (req: Record<string, unknown>) => JSON.parse((req as { data: { content: string } }).data.content);

  it('askQuestions：按钮 value 归位答案，form_value.note 作为补充说明一并返回', async () => {
    const { port, sent } = portWithSpy();
    const promise = port.askQuestions('T-1', [q]);
    expect(sent).toHaveLength(1);
    const value = actionsOf(cardOf(sent[0]))[1];
    const update = port.handleCardAction(value, { note: '前提是先做灰度' });
    // 替换卡片必须保留原问题上下文与补充说明（真机缺陷回归）
    expect(JSON.stringify(update)).toContain('撤销策略');
    expect(JSON.stringify(update)).toContain('先做灰度');
    const answers = await promise;
    expect(answers[0]).toMatchObject({ id: 'Q1', answer: '支持单 Key 撤销', note: '前提是先做灰度' });
  });

  it('confirmGate：approve → approved=true；reject 带说明 → note 回传', async () => {
    const { port, sent } = portWithSpy();
    const p1 = port.confirmGate('T-1', 'g', 's', []);
    port.handleCardAction(actionsOf(cardOf(sent[0]))[0]);
    expect(await p1).toEqual({ approved: true, note: undefined });

    const p2 = port.confirmGate('T-1', 'g', 's', []);
    port.handleCardAction(actionsOf(cardOf(sent[1]))[1], { note: '计划漏了限流' });
    expect(await p2).toEqual({ approved: false, note: '计划漏了限流' });
  });

  it('空白 note 视为未填写（不污染反馈文件）', async () => {
    const { port, sent } = portWithSpy();
    const p = port.confirmGate('T-1', 'g', 's', []);
    port.handleCardAction(actionsOf(cardOf(sent[0]))[0], { note: '   ' });
    expect((await p).note).toBeUndefined();
  });

  it('打字回答：选项前缀匹配，余下文字作为补充说明', async () => {
    const { port } = portWithSpy();
    const p = port.askQuestions('T-1', [q]);
    const r = port.tryAnswerByText('支持单 Key 撤销 但先做灰度');
    expect(r).toMatchObject({ status: 'resolved', label: 'Q1', answer: '支持单 Key 撤销', note: '但先做灰度' });
    expect((await p)[0]).toMatchObject({ answer: '支持单 Key 撤销', note: '但先做灰度' });
  });

  it('打字回答卡点：通过/驳回关键词 + 理由', async () => {
    const { port } = portWithSpy();
    const p = port.confirmGate('T-1', 'plan-approval', 's', []);
    expect(port.tryAnswerByText('驳回 计划漏了限流')).toMatchObject({ status: 'resolved', answer: 'reject' });
    expect(await p).toEqual({ approved: false, note: '计划漏了限流' });
  });

  it('多项待答时要求指明；支持「Q2 …」定位；未知 Qn 明确报错', async () => {
    const { port } = portWithSpy();
    const q2: OpenQuestion = { ...q, id: 'Q2', options: ['通过', '不通过'], recommended: '通过' };
    const p = port.askQuestions('T-1', [q, q2]);
    expect(port.pendingLabels()).toEqual(['Q1', 'Q2']);
    expect(port.tryAnswerByText('通过')).toMatchObject({ status: 'ambiguous' });
    expect(port.tryAnswerByText('Q9 通过')).toMatchObject({ status: 'ambiguous' });
    expect(port.tryAnswerByText('Q2 不通过 页面报500')).toMatchObject({ status: 'resolved', label: 'Q2', answer: '不通过' });
    // 只剩 Q1 时无需指明
    expect(port.tryAnswerByText('不做单独撤销')).toMatchObject({ status: 'resolved', label: 'Q1' });
    await p;
  });

  it('多问题合并为一张卡：一次发送，已答项就地变 ✅ 且其余按钮保留', async () => {
    const { port, sent } = portWithSpy();
    const mk = (id: string): OpenQuestion => ({ id, question: `问题${id}`, options: ['通过', '不通过'], recommended: '通过', why: 'w' });
    const qs = [mk('Q1'), mk('Q2'), mk('Q3')];
    const p = port.askQuestions('T-1', qs);
    expect(sent).toHaveLength(1); // 3 个问题只发 1 张卡，不刷屏
    const card = cardOf(sent[0]);
    const groups = (card.elements as El[]).filter((e) => e.tag === 'action');
    expect(groups).toHaveLength(3);
    expect(JSON.stringify(card.header)).toContain('待确认 3 项');

    // 点 Q2 的"不通过"→ 返回重绘卡：Q2 变 ✅，Q1/Q3 仍有按钮
    const q2Buttons = groups[1].actions as El[];
    const updated = port.handleCardAction(q2Buttons[1].value as CardAction)!;
    expect((updated.elements as El[]).filter((e) => e.tag === 'action')).toHaveLength(2);
    const s = JSON.stringify(updated);
    expect(s).toContain('已回答');
    expect(s).toContain('待回答 2');
    port.tryAnswerByText('全部通过');
    await p;
  });

  it('「全部通过」一次答完所有项；不匹配的项报告为仍待回答', async () => {
    const { port } = portWithSpy();
    const mk = (id: string, opts: string[]): OpenQuestion => ({ id, question: id, options: opts, recommended: opts[0], why: 'w' });
    const p = port.askQuestions('T-1', [mk('Q1', ['通过', '不通过']), mk('Q2', ['通过', '不通过']), mk('Q3', ['A', 'B'])]);
    const r = port.tryAnswerByText('全部通过');
    expect(r).toMatchObject({ status: 'resolved-batch', labels: ['Q1', 'Q2'], answer: '通过', skipped: ['Q3'] });
    expect(port.pendingLabels()).toEqual(['Q3']); // 未匹配项仍待回答
    port.tryAnswerByText('A');
    const answers = await p;
    expect(answers.map((a) => a.answer)).toEqual(['通过', '通过', 'A']);
  });

  it('「Q1 Q3 通过」多目标一次回答', async () => {
    const { port } = portWithSpy();
    const mk = (id: string): OpenQuestion => ({ id, question: id, options: ['通过', '不通过'], recommended: '通过', why: 'w' });
    const p = port.askQuestions('T-1', [mk('Q1'), mk('Q2'), mk('Q3')]);
    expect(port.tryAnswerByText('Q1 Q3 通过')).toMatchObject({ status: 'resolved-batch', labels: ['Q1', 'Q3'] });
    expect(port.pendingLabels()).toEqual(['Q2']);
    port.tryAnswerByText('不通过 还没验');
    await p;
  });

  it('无待答项或不像表决 → status=none（不劫持指令）', () => {
    const { port } = portWithSpy();
    expect(port.tryAnswerByText('通过')).toEqual({ status: 'none' });
    void port.confirmGate('T-1', 'g', 's', []);
    expect(port.tryAnswerByText('看下进度')).toEqual({ status: 'none' });
  });

  it('自由文本仅在 allowFreeText 时作为答案', async () => {
    const { port } = portWithSpy();
    const p = port.askQuestions('T-1', [q]);
    expect(port.tryAnswerByText('我觉得应该按季度轮换')).toEqual({ status: 'none' });
    expect(port.tryAnswerByText('我觉得应该按季度轮换', true)).toMatchObject({ status: 'resolved' });
    expect((await p)[0].answer).toBe('我觉得应该按季度轮换');
  });

  it('重复点击/未知 key：返回 null 不重复归位', async () => {
    const { port, sent } = portWithSpy();
    const p = port.confirmGate('T-1', 'g', 's', []);
    const approve = actionsOf(cardOf(sent[0]))[0];
    expect(port.handleCardAction(approve)).not.toBeNull();
    expect(port.handleCardAction(approve)).toBeNull();
    expect(port.handleCardAction(undefined)).toBeNull();
    await p;
  });
});

describe('群消息文本解析', () => {
  it('去掉 @ 占位符与多余空白，并标记 mentioned', () => {
    expect(parseMessageText(JSON.stringify({ text: '@_user_1  现在到哪了 ' }), 'text')).toEqual({
      text: '现在到哪了',
      mentioned: true,
    });
    expect(parseMessageText(JSON.stringify({ text: '/list' }), 'text')).toEqual({ text: '/list', mentioned: false });
  });
  it('非文本消息与空内容返回 null', () => {
    expect(parseMessageText(JSON.stringify({ text: '@_user_1' }), 'text')).toBeNull();
    expect(parseMessageText('{"image_key":"x"}', 'image')).toBeNull();
    expect(parseMessageText(undefined)).toBeNull();
  });
});

describe('引用/合并转发展开（renderQuotedItems）', () => {
  const text = (t: string): QuotedItem => ({ msg_type: 'text', body: { content: JSON.stringify({ text: t }) } });

  it('合并转发：跳过父项占位标题，按序拼接文本子消息，图片打占位符', () => {
    // 夹具形状取自真机 im.message.get 的返回（2026-08-19 msg-probe 实测）
    const items: QuotedItem[] = [
      { msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } },
      {
        msg_type: 'post',
        body: { content: JSON.stringify({ title: '', content: [[{ tag: 'img', image_key: 'img_x' }]] }) },
      },
      text('我想区分下 谁调用最多'),
      text('然后把那个异常调用的给揪出来'),
    ];
    const out = renderQuotedItems(items);
    expect(out).not.toContain('Merged and Forwarded');
    expect(out).toContain('[图片，未解析]');
    expect(out).toContain('我想区分下 谁调用最多');
    expect(out.indexOf('区分下')).toBeLessThan(out.indexOf('揪出来'));
  });

  it('引用普通文本消息：单条展开', () => {
    expect(renderQuotedItems([text('原始需求在这')])).toBe('原始需求在这');
  });

  it('富文本标题与文字段落拍平；未知类型标注不吞', () => {
    const items: QuotedItem[] = [
      {
        msg_type: 'post',
        body: {
          content: JSON.stringify({
            title: '需求截图',
            content: [[{ tag: 'text', text: '第一段' }, { tag: 'a', text: '链接文字' }]],
          }),
        },
      },
      { msg_type: 'audio' },
    ];
    const out = renderQuotedItems(items);
    expect(out).toContain('需求截图');
    expect(out).toContain('第一段链接文字');
    expect(out).toContain('[audio消息，未解析]');
  });

  it('超长引用截断并注明', () => {
    const out = renderQuotedItems([text('长'.repeat(5000))]);
    expect(out.length).toBeLessThan(3100);
    expect(out).toContain('已截断');
  });

  it('坏 JSON 与空列表：安静降级为空串', () => {
    expect(renderQuotedItems([{ msg_type: 'text', body: { content: '{oops' } }])).toBe('');
    expect(renderQuotedItems([])).toBe('');
  });
});
