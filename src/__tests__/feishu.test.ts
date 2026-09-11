import { describe, expect, it } from 'vitest';
import { gateCard, questionCard, statusCard, type CardAction } from '../feishu/card.js';
import { attachmentRef, FeishuPort, parseMessageText, renderQuotedItems, splitTrailingRequest, type QuotedItem } from '../feishu/port.js';
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

  it('「全部通过，但是…新需求」：表决摘出、新诉求作为 tail 分出来（2026-09-04 实测：新需求被灌进 6 个 Q 的备注）', async () => {
    const { port } = portWithSpy();
    const mk = (id: string): OpenQuestion => ({ id, question: id, options: ['通过', '不通过'], recommended: '通过', why: 'w' });
    const p = port.askQuestions('T-1', [mk('Q1'), mk('Q2')]);
    const r = port.tryAnswerByText('全部通过，但是我希望在数据域tab页面就能看到哪些域有未设置权限的表，并提供一个小弹框');
    expect(r).toMatchObject({ status: 'resolved-batch', labels: ['Q1', 'Q2'], answer: '通过' });
    expect((r as { tail?: string }).tail).toContain('数据域tab页面');
    port.tryAnswerByText('全部通过');
    const answers = await p;
    expect(answers.every((a) => !a.note)).toBe(true); // 新诉求没有污染任何一项的备注
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

  describe('富文本（post）解析（2026-09-02 实测：<p></p> 粘上 /new 判成没听懂，用户被迫重打）', () => {
    it('结构化 runs 优先：无 HTML 残片，at 标记算提及', () => {
      const content = JSON.stringify({
        title: '',
        content: [
          [{ tag: 'at', user_id: 'ou_x' }, { tag: 'text', text: '/new 修复色卡图丢失：' }],
          [{ tag: 'text', text: '`payload_builder.py` 里重试三次' }],
        ],
      });
      expect(parseMessageText(content, 'post')).toEqual({
        text: '/new 修复色卡图丢失： `payload_builder.py` 里重试三次',
        mentioned: true,
      });
    });
    it('平铺 text 兜底：清 <p>/<br> 段落标签，但不动代码里的泛型尖括号', () => {
      const flat = JSON.stringify({ text: '/new<p></p> 修复 Array<string> 解析<br/>第二行' });
      expect(parseMessageText(flat, 'post')).toEqual({
        text: '/new 修复 Array<string> 解析 第二行',
        mentioned: false,
      });
    });
    it('text 类型消息不做任何标签清洗（用户真写了 <p> 就保留）', () => {
      expect(parseMessageText(JSON.stringify({ text: '解释下 <p> 标签' }), 'text')).toEqual({
        text: '解释下 <p> 标签',
        mentioned: false,
      });
    });
  });
});

describe('splitTrailingRequest（表决 + 转折 + 新诉求）', () => {
  it('短表决 + 转折 + 长诉求 → 拆出 tail', () => {
    const r = splitTrailingRequest('通过，但是我希望在数据域tab页面就能看到哪些域有未设置权限的表');
    expect(r.verdict).toBe('通过');
    expect(r.tail).toContain('数据域tab页面');
  });
  it('给表决本身的短补充不拆；无转折词不拆', () => {
    expect(splitTrailingRequest('通过，因为查过了').tail).toBeUndefined();
    expect(splitTrailingRequest('通过').tail).toBeUndefined();
    expect(splitTrailingRequest('无法验证 本环境没有 MCP 客户端').tail).toBeUndefined();
  });
  it('「另外/还有/我还想」等词同样触发', () => {
    expect(splitTrailingRequest('无法验证，另外我还想加一个批量导出未覆盖清单的按钮').tail).toContain('批量导出');
  });
});

describe('引用/合并转发展开（renderQuotedItems）', () => {
  const text = (t: string): QuotedItem => ({ msg_type: 'text', body: { content: JSON.stringify({ text: t }) } });

  it('合并转发：跳过父项占位标题，按序拼接文本子消息；子消息图片只占位不登记（飞书 234043 不开放下载，真机实测）', () => {
    // 夹具形状取自真机 im.message.get 的返回（2026-08-19 msg-probe 实测）
    const items: QuotedItem[] = [
      { msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } },
      {
        msg_type: 'post',
        message_id: 'om_sub1',
        body: { content: JSON.stringify({ title: '', content: [[{ tag: 'img', image_key: 'img_x' }]] }) },
      },
      text('我想区分下 谁调用最多'),
      text('然后把那个异常调用的给揪出来'),
      { msg_type: 'file', message_id: 'om_sub2', body: { content: JSON.stringify({ file_key: 'fk', file_name: 'a.docx' }) } },
    ];
    const { text: out, resources } = renderQuotedItems(items);
    expect(out).not.toContain('Merged and Forwarded');
    expect(out).toContain('[图片，未解析');
    expect(out).toContain('[文件，未解析');
    expect(resources).toEqual([]);
    expect(out).toContain('我想区分下 谁调用最多');
    expect(out.indexOf('区分下')).toBeLessThan(out.indexOf('揪出来'));
  });

  it('引用普通文本消息：单条展开，无资源登记', () => {
    expect(renderQuotedItems([text('原始需求在这')])).toEqual({ text: '原始需求在这', resources: [] });
  });

  it('引用卡片消息（interactive）：抽出卡片文字——人引用机器人的问题卡说「这是原来的回复」时，会话要能看到那几个问题（2026-09-04 实测）', () => {
    const q: OpenQuestion = { id: 'Q1', question: '展示位置放哪里？', options: ['列表页', '详情页'], recommended: '列表页', why: '运营最常看' };
    const card = questionCard('LS-9', q, 'k1');
    const { text: out, resources } = renderQuotedItems([{ msg_type: 'interactive', message_id: 'om_c', body: { content: JSON.stringify(card) } }]);
    expect(out).toContain('【引用的卡片内容】');
    expect(out).toContain('展示位置放哪里');
    expect(out).toContain('列表页');
    expect(resources).toEqual([]);
    // v2 卡片（schema 2.0 / body.elements）同样抽得出；坏 JSON 给占位而不是抛
    const v2 = JSON.stringify({ schema: '2.0', header: { title: { tag: 'plain_text', content: '结果' } }, body: { elements: [{ tag: 'markdown', content: '1. 触发方式：自动' }] } });
    expect(renderQuotedItems([{ msg_type: 'interactive', body: { content: v2 } }]).text).toContain('触发方式：自动');
    expect(renderQuotedItems([{ msg_type: 'interactive', body: { content: '{oops' } }]).text).toContain('无可读文字');
    // im.message.get 拉回来的卡是 post 形状（真机 2026-09-04）：文字在 elements[][].text
    const fetched = JSON.stringify({ title: '执行结果 · lakeghost', elements: [[{ tag: 'text', text: '结论:目前没有这个功能' }, { tag: 'text', text: '\n\n1. 展示位置：都做？' }]] });
    const t = renderQuotedItems([{ msg_type: 'interactive', body: { content: fetched } }]).text;
    expect(t).toContain('执行结果 · lakeghost');
    expect(t).toContain('目前没有这个功能');
    expect(t).toContain('展示位置');
  });

  it('引用图片消息（非合并转发）：登记下载引用，文本占 marker 位', () => {
    const { text: out, resources } = renderQuotedItems([
      { msg_type: 'image', message_id: 'om_1', body: { content: JSON.stringify({ image_key: 'img_k1' }) } },
    ]);
    expect(resources).toEqual([{ messageId: 'om_1', fileKey: 'img_k1', marker: '[图片#1]', kind: 'image' }]);
    expect(out).toBe('[图片#1]');
  });

  it('引用文件消息（非合并转发）：登记 file 下载引用并保留原始文件名', () => {
    const { text: out, resources } = renderQuotedItems([
      {
        msg_type: 'file',
        message_id: 'om_f',
        body: { content: JSON.stringify({ file_key: 'file_k9', file_name: '湖灵MCP想法.docx' }) },
      },
    ]);
    expect(resources).toEqual([
      { messageId: 'om_f', fileKey: 'file_k9', marker: '[文件#1]', kind: 'file', name: '湖灵MCP想法.docx' },
    ]);
    expect(out).toBe('[文件#1]');
  });

  it('群内富文本带图（非合并转发）：图用所属消息的 message_id 登记，文字照常拍平', () => {
    const { text: out, resources } = renderQuotedItems([
      {
        msg_type: 'post',
        message_id: 'om_post',
        body: {
          content: JSON.stringify({
            title: '需求截图',
            content: [[{ tag: 'text', text: '第一段' }, { tag: 'img', image_key: 'img_p' }, { tag: 'a', text: '链接文字' }]],
          }),
        },
      },
      { msg_type: 'audio' },
    ]);
    expect(out).toContain('需求截图');
    expect(out).toContain('第一段[图片#1]链接文字');
    expect(out).toContain('[audio消息，未解析]');
    expect(resources).toEqual([{ messageId: 'om_post', fileKey: 'img_p', marker: '[图片#1]', kind: 'image' }]);
  });

  it('超长引用截断并注明', () => {
    const { text: out } = renderQuotedItems([text('长'.repeat(5000))]);
    expect(out.length).toBeLessThan(3100);
    expect(out).toContain('已截断');
  });

  it('坏 JSON 与空列表：安静降级为空串', () => {
    expect(renderQuotedItems([{ msg_type: 'text', body: { content: '{oops' } }]).text).toBe('');
    expect(renderQuotedItems([]).text).toBe('');
  });
});

describe('chooseOption 只认选项（strictOptions）', () => {
  it('自由文本不落位（真机事故回归：「它的回答我不会了」曾误确认建单）；选项前缀仍可解析', async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeClient = {
      im: { message: { create: async (req: Record<string, unknown>) => (sent.push(req), {}) } },
    };
    const port = new FeishuPort(fakeClient as never, null, { appId: 'a', appSecret: 's', chatId: 'c' });
    const p = port.chooseOption('指令', '怎么处理？', ['按 new 执行', '记为说明（/note）', '取消']);
    // 不匹配任何选项的自由文本：不落位，卡片继续等
    expect(port.tryAnswerByText('它的回答我不会了，你来整下', true)).toMatchObject({ status: 'none' });
    expect(port.pendingLabels()).toEqual(['选择']);
    // 选项前缀 + 补充说明：正常解析
    expect(port.tryAnswerByText('取消 我先问问同事', true)).toMatchObject({ status: 'resolved', answer: '取消' });
    expect(await p).toBe('取消');
  });
});

describe('attachmentRef：话题里直接甩的文件/图片进攒着队列（2026-09-11）', () => {
  it('file / image 消息解析出资源引用；text 与坏 JSON 返回 null', () => {
    expect(attachmentRef('file', '{"file_key":"file_v3_x","file_name":"提示词.xlsx"}', 'om_1')).toEqual({ messageId: 'om_1', fileKey: 'file_v3_x', marker: '', kind: 'file', name: '提示词.xlsx' });
    expect(attachmentRef('image', '{"image_key":"img_v2_y"}', 'om_2')).toEqual({ messageId: 'om_2', fileKey: 'img_v2_y', marker: '', kind: 'image' });
    expect(attachmentRef('text', '{"text":"hi"}', 'om_3')).toBeNull();
    expect(attachmentRef('file', 'not-json', 'om_4')).toBeNull();
    expect(attachmentRef('file', '{"file_key":"k"}', '')).toBeNull();
  });
});
