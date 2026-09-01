import { osaDistance } from './projects.js';
import { runClaudeJson } from './runner.js';
import type { Stage } from './types.js';

/**
 * 群内指令通道：斜杠命令（确定性）+ 自然语言（Haiku 分类）。
 * 破坏性指令（rewind/amend）经确认卡片二次确认，避免误识别改变工单走向。
 */

export const STAGES: Stage[] = ['clarify', 'plan', 'implement', 'review', 'ci', 'acceptance', 'compound'];

export type Command =
  | { kind: 'status'; ticket?: string }
  | { kind: 'list' }
  | { kind: 'dashboard' }
  | { kind: 'pause'; ticket: string }
  | { kind: 'resume'; ticket: string }
  | { kind: 'rewind'; ticket: string; stage: Stage; reason?: string }
  | { kind: 'amend'; ticket: string; text: string }
  | { kind: 'note'; ticket: string; text: string }
  | { kind: 'new'; ticket?: string; repo?: string; requirement: string }
  /** 回答待确认卡片：target 为 Q 编号或卡点名，text 为答案（含可选补充说明） */
  | { kind: 'answer'; ticket?: string; target?: string; text: string }
  /**
   * 单次执行：问一句 / 跑个测试 / 跑项目里的斜杠指令，不建工单不入看板。
   * sideEffect：分类器判断这句话要求的是有对外副作用的动作（部署/推送/发布…）。
   * 闸门不能只认斜杠语法——"帮我把镜像推一下"同样能拿着 Bash 把 latest 推上去。
   */
  | { kind: 'run'; project?: string; text: string; sideEffect?: boolean }
  /** 续聊：回复上一次 /run 的收尾问题，新会话拼上次输出接着办（见 followup.ts） */
  | { kind: 'followup'; text: string }
  /** 群内接入新项目（2026-08-31 用户在群里问「可以在对话中添加吗」——此前只有终端向导） */
  | { kind: 'addproject'; alias: string; repo: string; prefix: string; gitlab?: string; jenkins?: string; wiki?: string }
  /** 项目粘性：本群后续消息默认按该项目处理（不带别名 = 查看当前）；见 sticky.ts 头注 */
  | { kind: 'use'; alias?: string }
  /** 群↔项目绑定：在目标群里发，本群从此就是该项目的群（含工单通知路由） */
  | { kind: 'bind'; alias: string }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

/** 分类器需要的工单现场：知道跑到哪、在等什么，同一句话才能路由对 */
export interface TicketContext {
  ticket: string;
  stage: string;
  runState: string;
  /** 该工单当前待回答的卡片标签（Q1/plan-approval…） */
  pending: string[];
  halted?: string;
}

export function isDestructive(c: Command): boolean {
  return c.kind === 'rewind' || c.kind === 'amend';
}

/**
 * 分级确认：只读直接跑、记录类直接跑（可撤销性高）、改变流程走向的一律确认。
 * 这条策略是自然语言交互的安全阀——误识别的代价必须由人来兜。
 */
export function needsConfirm(c: Command): boolean {
  return isDestructive(c) || c.kind === 'pause';
}

/** 确认卡片上的话：说清"我理解为什么"和"会导致什么" */
export function describeCommand(c: Command): string {
  switch (c.kind) {
    case 'amend':
      return `**我理解为：修改 ${c.ticket} 的需求**\n> ${c.text}\n\n执行后：变更写入需求文件，工单**回退到澄清阶段重跑**（已完成的计划/实现/评审需要重做）。\n如果你只是想报告缺陷或补充说明，请选「记为说明」。`;
    case 'rewind':
      return `**我理解为：把 ${c.ticket} 回退到「${c.stage}」重跑**${c.reason ? `\n> 原因：${c.reason}` : ''}\n\n执行后：该阶段及其之后的阶段会重新跑（代码提交不回滚）。`;
    case 'pause':
      return `**我理解为：暂停 ${c.ticket}**\n\n执行后：当前阶段跑完即停，不会打断进行中的会话。`;
    default:
      return `我理解为：${c.kind}`;
  }
}

/** 缺陷现象的特征词——用来识别"报 bug"而不是"改需求" */
export function looksLikeDefectReport(text: string): boolean {
  return /(报错|异常|失败|不通过|无法|不能|没反应|不生效|挂起|超时|崩|error|invalid|malformed|expired|refused|timeout|\b[45]\d\d\b)/i.test(
    text,
  );
}

/**
 * 显式斜杠命令的语义体检（只在明显冲突时拦一下，保住"斜杠即明确"的效率）。
 * 触发场景来自真机事故：验收阶段用 /amend 报缺陷现象，会把工单退回澄清、作废全部下游工作。
 */
export function slashSanityIssue(c: Command, ctx?: TicketContext): string | null {
  if (c.kind !== 'amend' || !ctx) return null;
  // 已闭环的工单不能改需求：回退一个交付完成的工单几乎总是误操作，正确做法是开新单
  if (ctx.stage === '已闭环' || ctx.runState === '闭环') {
    return `**${ctx.ticket} 已经闭环**，改它的需求会把一个已交付的工单整体退回澄清重跑。新的需求应该开新工单。`;
  }
  const midFlight = ['implement', 'review', 'ci', 'acceptance', 'compound'].includes(ctx.stage);
  if (midFlight && looksLikeDefectReport(c.text)) {
    return `这条读起来像**缺陷现象**（工单正处于「${ctx.stage}」阶段），而 /amend 是**需求变更**——它会让工单回退到澄清重跑。`;
  }
  return null;
}

/**
 * 未 @ 机器人时，用关键词判断这句话是否像在跟流水线说话（避免给群聊闲聊花钱分类）。
 * @ 了机器人则一律进入分类——@ 本身就是明确的对话意图。
 */
export function looksLikeCommand(text: string): boolean {
  return (
    /(流水线|工单|需求|进度|状态|暂停|继续|回退|重做|重跑|重新做|计划|验收|澄清|到哪|走到|跑到|怎么样|新建|新需求|改成|改一下|补充|面板|总览|仪表盘|配置|地址|链接|什么情况)/.test(
      text,
    ) || /^\s*(status|list|dashboard|dash|panel|pause|resume|help|new|note|amend|rewind)\b/i.test(text)
  );
}

/**
 * 这句话是不是"项目自带的斜杠指令"（如 /docker-push）。
 * headless 只在提示词以斜杠开头时才把它展开成命令：一旦前面拼了任何文字（知识摘要、"运行一下"），
 * 它就退化成"聊聊这个命令"——花了钱、报告一切正常，实际什么都没执行。
 */
export function isProjectSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z][\w-]*(\s|$)/.test(text);
}

/**
 * 帮助文本用**真实示例**而不是 <占位符>——实测用户会把尖括号照抄进去
 * （`/new <LS-004> <需求>` 会试图建一个叫 `<LS-004>` 的工单，在 Windows 上是非法文件名）。
 */
export function helpText(): string {
  return [
    '**流水线指令**（斜杠命令，或直接用中文说；群里需 @ 我）：',
    '`/new LS-004 给 /mcp 端点加限流` 新建工单（工单号可省略，我会自动编号）',
    '`/dashboard` 运行面板：常用链接（仓库/看板/知识库/Jenkins）+ 运行情况 + 工单一览',
    '`/status LS-004` 查看进度时间线　`/list` 列出全部工单',
    '`/pause LS-004` 下个安全点暂停　`/resume LS-004` 继续',
    '`/amend LS-004 需求改成……` 修改/追加需求（自动回退到澄清重跑）',
    '`/rewind LS-004 plan` 回退到指定阶段重跑（阶段：clarify/plan/implement/review/ci/acceptance）',
    '`/note LS-004 补充一句说明` 追加说明，下个阶段会读到（不回退）',
    '`/run 这个仓库的鉴权中间件在哪` 单次执行：问一句 / 跑测试（不建工单、不入看板）',
    '`/addproject nova D:/work/nova NV gitlab=组/项目 jenkins=任务名 wiki=节点token` 接入新项目（后三项可省；gitlab/wiki 直接粘 URL 也行）',
    '`/use nova` 本群后续消息默认按该项目处理（几小时内有效；`/use` 查看当前）',
    '`/bind nova` 把**当前群**绑定为该项目的群：消息默认归它，工单通知也发到这里（在目标群里发）',
    '`/run /docker-push` 跑项目/个人的斜杠指令或 skill——**斜杠要写在最前面**，会先弹确认卡（写清会跑什么命令、有什么对外副作用）',
    '`/re 1 要 push；未跟踪目录删掉` 回复上一次 /run 结尾的问题，接着办完（直接说也行，我会先确认）',
    '_直接写内容，不要照抄尖括号。_',
  ].join('\n');
}

/** 全部斜杠命令名（拼错提示用） */
const SLASH_COMMANDS = [
  'help', 'list', 'dashboard', 'status', 'pause', 'resume', 'amend', 'rewind',
  'note', 'new', 'run', 're', 'use', 'bind', 'addproject',
];

/** 斜杠命令拼错时给最接近的候选（「/dashborad」实测，2026-09-01）；对不上返回 null */
export function nearestSlash(cmd: string): string | null {
  const c = cmd.toLowerCase();
  const best = SLASH_COMMANDS.map((n) => ({ n, d: osaDistance(c, n) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d > 0 && best.d <= 2 ? best.n : null;
}

/** 合法工单号（校验用）：字母开头，仅字母数字连字符下划线——要能安全用作文件名与分支名 */
export const TICKET_RE = /^[A-Za-z][A-Za-z0-9_-]{1,31}$/;

/**
 * 「看起来像用户输入的工单号」（识别用，比校验更严）：必须含数字。
 * 否则 `/new MCP 调用方式需要调整` 会把 MCP 当成工单号，把真正的需求截掉一截。
 */
export const TICKET_LIKE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
export function looksLikeTicket(s: string): boolean {
  return TICKET_LIKE.test(s) && /\d/.test(s);
}

/** 剥掉用户照抄的包裹符号（尖括号 / 中文括号 / 引号 / 方括号） */
export function unwrap(s: string): string {
  return s
    .trim()
    .replace(/^[<「【《"'`[（(]+/, '')
    .replace(/[>」】》"'`\]）)]+$/, '')
    .trim();
}

/**
 * 从需求文本里识别「仓库<路径>」前缀，抽成 repo 并从正文剥离。
 * 路径字符集刻意排除 `.`——实测「仓库D:/work/lake_spirit.MCP调用方式…」里句号紧贴路径，
 * 允许 `.` 会把后面的需求正文一起吞进路径（宁可截断带点的目录名，也不能吃掉需求）。
 */
export function extractRepo(text: string): { repo?: string; rest: string } {
  const m = /^仓库\s*[:：]?\s*([A-Za-z]:[\\/][^\s,，。;；.]+)/.exec(text);
  if (!m) return { rest: text };
  return { repo: m[1], rest: text.slice(m[0].length).replace(/^[.。,，:：\s]+/, '').trim() };
}

/** 斜杠命令解析（确定性优先，零成本） */
export function parseSlash(text: string): Command | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const [cmd, ...rest] = t.slice(1).split(/\s+/);
  const arg = unwrap(rest.join(' '));
  const first = unwrap(rest[0] ?? '') || undefined;
  const others = rest.slice(1);
  const ticketOk = first && looksLikeTicket(first) ? first : undefined;
  switch (cmd.toLowerCase()) {
    case 'help':
      return { kind: 'help' };
    case 'list':
      return { kind: 'list' };
    case 'dashboard':
    case 'dash':
    case 'panel':
      return { kind: 'dashboard' };
    case 'status':
      return { kind: 'status', ticket: ticketOk };
    case 'pause':
      return ticketOk ? { kind: 'pause', ticket: ticketOk } : { kind: 'unknown', text: t };
    case 'resume':
    case 'continue':
      return ticketOk ? { kind: 'resume', ticket: ticketOk } : { kind: 'unknown', text: t };
    case 'rewind': {
      const stage = unwrap(others[0] ?? '') as Stage;
      if (!ticketOk || !STAGES.includes(stage)) return { kind: 'unknown', text: t };
      return { kind: 'rewind', ticket: ticketOk, stage, reason: unwrap(others.slice(1).join(' ')) || undefined };
    }
    case 'amend': {
      const body = unwrap(others.join(' '));
      return ticketOk && body ? { kind: 'amend', ticket: ticketOk, text: body } : { kind: 'unknown', text: t };
    }
    case 'note': {
      const body = unwrap(others.join(' '));
      return ticketOk && body ? { kind: 'note', ticket: ticketOk, text: body } : { kind: 'unknown', text: t };
    }
    case 'new': {
      // 第一段像工单号就当工单号，否则整句都是需求（自动编号）——用户常常直接写需求
      const raw = ticketOk ? unwrap(others.join(' ')) : arg;
      const { repo, rest: body } = extractRepo(raw);
      return body ? { kind: 'new', ticket: ticketOk, repo, requirement: body } : { kind: 'unknown', text: t };
    }
    case 'run':
    case 'ask':
    case 'skill':
      return arg ? { kind: 'run', text: arg } : { kind: 'unknown', text: t };
    case 'use':
      return { kind: 'use', alias: first };
    case 'bind':
      return first ? { kind: 'bind', alias: first } : { kind: 'unknown', text: t };
    case 'addproject':
    case 'add-project': {
      // 位置参数三个必填 + 可选 key=value（顺序随意）
      const pos = rest.map((s) => unwrap(s)).filter((s) => s && !s.includes('='));
      const kv = Object.fromEntries(
        rest.filter((s) => s.includes('=')).map((s) => [s.slice(0, s.indexOf('=')).toLowerCase(), unwrap(s.slice(s.indexOf('=') + 1))]),
      ) as Record<string, string>;
      const [alias, repo, prefix] = pos;
      if (!alias || !repo || !prefix) return { kind: 'unknown', text: t };
      return { kind: 'addproject', alias, repo, prefix, gitlab: kv.gitlab, jenkins: kv.jenkins, wiki: kv.wiki };
    }
    case 're':
    case 'reply':
      return arg ? { kind: 'followup', text: arg } : { kind: 'unknown', text: t };
    default:
      return { kind: 'unknown', text: t };
  }
}

export const COMMAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'confidence'],
  properties: {
    kind: {
      type: 'string',
      enum: [
        'status', 'list', 'dashboard', 'pause', 'resume', 'rewind',
        'amend', 'note', 'new', 'answer', 'run', 'help', 'unknown',
      ],
    },
    ticket: { type: ['string', 'null'] },
    stage: { type: ['string', 'null'], enum: [...STAGES, null] },
    target: { type: ['string', 'null'], description: 'answer 时的目标：Q 编号或卡点名' },
    text: {
      type: ['string', 'null'],
      description: 'amend/note/new/answer 的正文（run 不用填，会原样使用用户原话；这里永远不要写判断理由）',
    },
    side_effect: {
      type: ['boolean', 'null'],
      description: 'run 专用：这句话是否要求执行有对外副作用的动作（部署/推送/发布/上线/删数据）',
    },
    confidence: { type: 'number', description: '0-1，低于 0.6 视为不确定' },
  },
} as const;

/**
 * 带现场上下文的意图识别。
 * 关键在于分类器要知道"工单跑到哪、在等什么"——同一句"不通过，报 500"
 * 在有待答卡片时是回答，在没有时是缺陷说明。
 */
export function buildClassifyPrompt(text: string, contexts: TicketContext[]): string {
  const ctxLines = contexts.length
    ? contexts.map(
        (c) =>
          `- ${c.ticket}：阶段=${c.stage}，状态=${c.runState}${c.pending.length ? `，**正在等回答：${c.pending.join('、')}**` : ''}${c.halted ? `，挂起原因=${c.halted.slice(0, 60)}` : ''}`,
      )
    : ['（暂无工单）'];
  return [
    '你是开发流水线的指令路由器。把用户这句话映射成一个意图。',
    '',
    '## 当前现场',
    ...ctxLines,
    '',
    '## 可选意图',
    'answer：回答某张待确认卡片（**只有现场显示"正在等回答"时才可用**）。target 填 Q 编号或卡点名，text 填答案本身（如"不通过 页面报500"）。',
    'note：给**某个工单**追加一条说明/缺陷现象，不改需求、不回退。text 填说明内容，ticket 必填。',
    '  线上出故障、但没指明是哪个工单 → **run（先诊断）**，不要 note——挂不到工单上的 note 没有意义。',
    'amend：**修改需求本身**（会回退到澄清重跑）。只有明确要求增删改需求时才用。',
    'rewind：回退到指定阶段重跑，需要 stage。',
    'run：单次执行——问代码库的问题、跑测试、跑一条已有的指令/skill，不建工单。**它有 Bash 权限，不是只读的**。',
    '  "这个仓库的鉴权在哪""跑一下前端测试""帮我看看 X 是怎么实现的" → run。',
    '  注意与 new 的分界：**要改代码就是 new**（建工单走流程），只是想看/问/验证/跑现成命令才是 run。',
    '  **side_effect**：这句话要求的动作会不会改变共享状态——部署、上线、推镜像、发包、推远端分支、改数据库，',
    '  也包括 git 结构性操作：**合并到 master/主干、删除分支或 worktree、改写历史、打 tag**（实测漏判过"合并到 master 后删除"）。',
    '  是就填 true（会先让人确认再执行），只是看代码/跑本地测试填 false。拿不准填 true。',
    'dashboard：运行面板（常用链接 + 整体运行情况）。"看下面板/总览/配置在哪/地址是多少/现在什么情况" → dashboard。',
    // resume 曾只是兜底行里的裸词条：实测「继续 LS-013」被判成 unknown@30%，用户被迫退回斜杠命令
    'resume：继续/恢复某个工单（「继续 LS-013」「LS-7 接着跑」「恢复 LS-2」）。ticket 必填——带工单号的「继续」是 resume；不带工单号的「继续」多半是在回应上一条执行结果，判 unknown 交给续聊。',
    'status（单个工单的进度时间线）/ list / pause / new / help / unknown。',
    '想接入/新增一个**项目**（不是工单）→ help：帮助里有 /addproject 的用法，接入必须用显式命令。',
    '',
    '## 判定规则（按优先级）',
    '1. 现场正在等回答，且这句话像是在回应那个问题 → answer。',
    '2. 描述"某功能报错/异常/不通过/无法使用"等**现象** → note 或 answer，**绝不是 amend**。',
    '   报缺陷不等于改需求——误判为 amend 会作废已完成的计划与实现。',
    '3. 明确说"需求改成…/再加一个要求/这个不做了" → amend，**但仅限于正在进行中的工单**。',
    '4. **描述一件要做的事、却没指明是哪个在跑的工单 → new（新需求），不是 amend**。',
    '   已闭环的工单不能改需求——想改就是一个新工单。现场里状态为"闭环"的工单永远不能作为 amend 的对象。',
    '5. 只提到一个进行中的工单时 ticket 填它；说不清是哪个工单就把 confidence 打低。',
    '6. 拿不准就 unknown + 低 confidence——宁可多问一句，不要猜。',
    '',
    `## 用户原话\n${text}`,
  ].join('\n');
}

export interface Classified {
  command: Command;
  confidence: number;
  /**
   * 调用本身失败（异常 / 没给结构化返回）的原因。
   * 必须和"模型判成 unknown"区分开：前者要提示用户重发，后者是正常的"没听懂"。
   * 之前两者都退化成 confidence 0 的 unknown，一次 API 抖动就让生产缺陷报告吃了闭门羹，日志里还查不出原因。
   */
  error?: string;
  /**
   * 意图听懂了、但缺工单号（note/amend 必须挂在某个工单上）。
   * 不能当"没听懂"丢掉：一条生产缺陷报告因为没写工单号就石沉大海，是最伤信任的失败方式。
   * 由调用方问一句"挂到哪个工单"，或改成先跑一次诊断。
   */
  missingTicket?: { kind: 'note' | 'amend'; text: string };
}

/**
 * 自然语言分类。失败 → unknown/0；低置信由调用方决定是给候选还是放弃。
 *
 * 默认 sonnet 而不是 haiku：实测（scripts/classify-probe.ts，8 条语句 ×2 轮）
 * haiku 5~6/8 且同一句话两轮结论会变——"帮我把前端镜像推到仓库"曾被判成 new@80%，
 * 那会给一次部署请求建工单、一路跑澄清到实现；"把这个项目部署一下"两轮都成了 unknown。
 * sonnet 7~8/8 且置信度更高。一次分类几分钱，比误路由的代价便宜得多。
 * 想省钱可用 PIPELINE_CLASSIFY_MODEL 覆盖。
 */
export async function classifyCommand(
  text: string,
  contexts: TicketContext[],
  cwd = process.cwd(),
  model = process.env.PIPELINE_CLASSIFY_MODEL ?? 'sonnet',
): Promise<Classified> {
  let lastError = '';
  // 分类只读且幂等，失败重试一次：实测这个环境的 API 会偶发断流，
  // 一次抖动不该让用户的消息吃闭门羹。有副作用的执行则相反，绝不自动重试。
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { envelope } = await runClaudeJson({
        cwd,
        prompt: buildClassifyPrompt(text, contexts),
        tools: 'Read',
        model,
        maxTurns: 3,
        budgetUsd: 0.2,
        schema: COMMAND_SCHEMA,
      });
      const so = envelope.structured_output as unknown as
        | {
            kind: Command['kind'];
            ticket?: string | null;
            stage?: Stage | null;
            target?: string | null;
            text?: string | null;
            side_effect?: boolean | null;
            confidence: number;
          }
        | undefined;
      if (!so) {
        lastError = `无结构化返回：${(envelope.result ?? '空').slice(0, 120)}`;
        continue;
      }
      const command = normalize(so, text, contexts.map((c) => c.ticket));
      const needsTicket = so.kind === 'note' || so.kind === 'amend';
      return {
        command,
        confidence: typeof so.confidence === 'number' ? so.confidence : 0,
        missingTicket:
          command.kind === 'unknown' && needsTicket
            ? { kind: so.kind as 'note' | 'amend', text: so.text || text }
            : undefined,
      };
    } catch (e) {
      lastError = (e as Error).message.slice(0, 200);
    }
  }
  return { command: { kind: 'unknown', text }, confidence: 0, error: lastError };
}

/** 把分类结果补全为合法 Command（缺 ticket 时若只有一个活跃工单则自动填充） */
export function normalize(
  so: {
    kind: Command['kind'];
    ticket?: string | null;
    stage?: Stage | null;
    target?: string | null;
    text?: string | null;
    side_effect?: boolean | null;
  },
  original: string,
  tickets: string[],
): Command {
  const ticket = so.ticket ?? (tickets.length === 1 ? tickets[0] : undefined);
  switch (so.kind) {
    case 'answer':
      return so.text ? { kind: 'answer', ticket, target: so.target ?? undefined, text: so.text } : { kind: 'unknown', text: original };
    case 'run':
      // 一律用原话，不用分类器的 text：实测模型会把 text 填成自己的判断理由
      // （"…属于只读诊断操作"），于是用户的现象描述和 URL 全丢了，执行会话拿到一段推理当需求
      return { kind: 'run', text: original, sideEffect: so.side_effect === true };
    case 'help':
      return { kind: 'help' };
    case 'list':
      return { kind: 'list' };
    case 'dashboard':
      return { kind: 'dashboard' };
    case 'status':
      return { kind: 'status', ticket };
    case 'pause':
      return ticket ? { kind: 'pause', ticket } : { kind: 'unknown', text: original };
    case 'resume':
      return ticket ? { kind: 'resume', ticket } : { kind: 'unknown', text: original };
    case 'rewind':
      return ticket && so.stage && STAGES.includes(so.stage)
        ? { kind: 'rewind', ticket, stage: so.stage, reason: so.text ?? undefined }
        : { kind: 'unknown', text: original };
    case 'amend':
      return ticket && so.text ? { kind: 'amend', ticket, text: so.text } : { kind: 'unknown', text: original };
    case 'note':
      return ticket && so.text ? { kind: 'note', ticket, text: so.text } : { kind: 'unknown', text: original };
    case 'new':
      return so.text ? { kind: 'new', requirement: so.text } : { kind: 'unknown', text: original };
    default:
      return { kind: 'unknown', text: original };
  }
}
