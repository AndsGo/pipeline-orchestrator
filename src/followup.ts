import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 轻量续聊协议：让 /run 收尾的提问有一条"答案回得去的路"。
 *
 * /run 会话是一次性的——结尾若向人提了问题（要不要 push、未跟踪目录怎么处理），
 * 问题只存在于结果卡的文字里：没有待答卡、没有可续的会话，用户的回复会被分类器
 * 判成 answer 后因无处投递而石沉大海（实测事故）。
 *
 * 修法不是保活会话（占并发闸门、人几小时不回就资源悬挂），而是记住最近一次执行的
 * sessionId → 收到答复时 `claude -p --resume` 真续会话：完整历史从盘上恢复，零信息损失，
 * 续轮成本约为拼接模式的十分之一（2026-08-19 实测 $0.006 vs $0.23+）。
 * resume 失败（会话文件被清等）降级为拼接模式：原始任务 + 上次完整输出 + 答复拼进新会话。
 */

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/last-run.json');

/** 续聊有效期：隔天再回"1"大概率已不是在回上次的问题，宁可让人重新说清 */
export const FOLLOWUP_TTL_MS = 24 * 60 * 60 * 1000;

/** 上次输出注入续聊提示词的截断上限。收尾问题在末尾——截头保尾 */
const OUTPUT_CAP = 20_000;

export interface LastRun {
  /** ISO 时间（该轮执行完成时刻） */
  at: string;
  /** 项目别名（续聊要回到同一个仓库——resume 的会话文件也按 cwd 存） */
  project: string;
  /** 该轮的用户原话：首轮 = /run 指令，续轮 = 答复 */
  command: string;
  /** 会话完整输出（含收尾问题） */
  output: string;
  /** 续聊轮次：首轮 0，每续一次 +1 */
  chain: number;
  /** claude 会话 ID：优先 --resume 真续（续完不变）；缺失或失效时走拼接降级 */
  sessionId?: string;
  /** 本链条第一轮的用户原话：拼接降级时防止原始任务在第 2 轮后丢失 */
  origin?: string;
  /**
   * 整段对话（首轮到本轮，按序）。建单要带走的是全部结论，不是最后一轮——续聊时 output 逐轮覆盖，
   * 中间轮次聊出来的东西以前只存在于 data/adhoc/ 留痕里。会话本身仍靠 sessionId --resume 复用，不重放。
   */
  transcript?: Round[];
}

export interface Round {
  /** 用户原话：首轮 = /run 指令，续轮 = 答复 */
  command: string;
  output: string;
}

/** 本轮并入链条：首轮只有自己；续轮 = 上一指针的整段对话 + 本轮（旧指针无 transcript 时由其 command/output 补出） */
export function withRound(prev: LastRun | null, round: Round): Round[] {
  if (!prev) return [round];
  return [...(prev.transcript ?? [{ command: prev.command, output: prev.output }]), round];
}

function roundsOf(last: LastRun): Round[] {
  return last.transcript ?? [{ command: last.command, output: last.output }];
}

/** 按轮渲染，预算从最新一轮往前分：最新结论最重要；超预算的老轮次只留用户原话，输出以留痕位置代替 */
function renderRounds(rounds: Round[], cap: number): string[] {
  let budget = cap;
  const out: string[] = [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i];
    let body: string;
    if (budget <= 0) body = '（本轮输出略，全文在编排器 data/adhoc/ 留痕）';
    else if (r.output.length > budget) {
      body = `${r.output.slice(0, budget)}\n…（后文过长已截断，全文在编排器 data/adhoc/ 留痕）`;
      budget = 0;
    } else {
      body = r.output;
      budget -= r.output.length;
    }
    out.unshift(`### 第 ${i + 1} 轮\n- ${i === 0 ? '指令' : '用户答复'}：${r.command.slice(0, 500)}\n- 输出：\n${body}`);
  }
  return out;
}

/**
 * 「/new」不带正文，或正文只是在指代刚才的对话（「按刚才聊的建单」）→ 该按对话草拟需求，而不是把这句话当需求。
 * 词面判断故意保守：句子要同时提到「刚才/上面/对话」和「建单/工单/需求」，且很短。
 */
export function isDraftFromChatRequest(requirement: string): boolean {
  const t = requirement.trim();
  if (!t) return true;
  return t.length <= 40 && /刚才|刚刚|上面|前面|上述|聊的|对话|讨论/.test(t) && /建|工单|需求|单/.test(t);
}

/** 把整段 /run 对话压成需求原文的提示词（sonnet 一次文本调用，无工具）。只要正文，不要开场白 */
export function composeRequirementDraftPrompt(last: LastRun): string {
  return [
    '下面是用户与助手在代码仓库里的一段排查/讨论对话（/run 单次执行及其续聊）。用户现在要「按这段对话建一张开发工单」。',
    '请把对话里已经达成的结论整理成一段需求原文，供后续澄清阶段使用。要求：',
    '- 只输出需求正文本身：不要开场白、标题、解释或结尾寒暄；中文；不超过 400 字。',
    '- 写清：要解决什么问题（背景一句话）、要做成什么样、范围内/范围外、对话里已确定的关键事实（文件、字段、口径原样引用）。',
    '- 用户明确说不做的事写进范围外，不要擅自扩大范围。',
    '- 对话里没有定论的点，以「待确认：…」逐条列在末尾，不要替用户拍板。',
    '',
    '## 对话记录',
    ...renderRounds(roundsOf(last), OUTPUT_CAP),
  ].join('\n');
}

/** 落盘最近一次执行指针（写失败不抛——指针丢了只是续不上聊，不能反过来影响结果送达） */
export function saveLastRun(r: LastRun, file = FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r), 'utf-8');
  } catch {
    /* 见上 */
  }
}

/** 读最近一次执行；无记录、损坏或超过 TTL 都返回 null（落盘是为了熬过看门狗重启 daemon） */
export function readLastRun(now = Date.now(), file = FILE): LastRun | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as LastRun;
    if (!r?.at || typeof r.output !== 'string' || typeof r.command !== 'string') return null;
    if (now - Date.parse(r.at) > FOLLOWUP_TTL_MS) return null;
    return r;
  } catch {
    return null;
  }
}

/** 卡片/日志里指代上次执行的短句：《指令前 60 字》（N 分钟前） */
export function describeLastRun(r: LastRun, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(r.at)) / 60_000));
  const ago = min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
  return `《${r.command.slice(0, 60)}》（${r.chain > 0 ? `续聊第 ${r.chain} 轮，` : ''}${ago}）`;
}

/**
 * 建单自动附带：把最近一次 /run 的输出整理成 00-intake.md 的参考附录。
 * 由来（LS-013，2026-08-25）：「将排查的结论创建一个工单进行修复」——结论躺在 /run 续聊里，
 * 工单只带走了这一句话，分诊直接抱怨「歧义高」，14 文件清单靠人手动贴回去补救。
 * 只附同项目、未过 TTL 的记录；相关性由澄清阶段自行判断（开头已声明「无关请忽略」）。
 */
export function intakeContextFromLastRun(last: LastRun | null, projectAlias: string): string | null {
  if (!last || last.project !== projectAlias) return null;
  const rounds = roundsOf(last);
  return [
    `以下是建单前最近一次单次执行（/run）及其续聊的完整记录（共 ${rounds.length} 轮），自动附带供澄清参考；若与本需求无关请忽略。`,
    `- 完成时间：${last.at}`,
    '',
    ...renderRounds(rounds, OUTPUT_CAP),
  ].join('\n');
}

/** 拼接降级模式的正文：原始任务 + 上一轮答复（若已是续轮）+ 上次输出 + 这次答复 */
export function composeFollowupPrompt(last: LastRun, reply: string): string {
  const clipped =
    last.output.length > OUTPUT_CAP
      ? `…（前文过长已截断，以下是输出的末尾部分）\n${last.output.slice(-OUTPUT_CAP)}`
      : last.output;
  const origin = last.origin ?? last.command;
  return [
    '你之前在本仓库执行过一次任务，结尾向用户提出了待决问题；现在用户回复了。',
    '请基于下面的记录接着办完，已完成的部分不要重做。',
    '',
    '## 原始任务（本链条第一轮的用户原话）',
    origin,
    ...(last.command !== origin ? ['', '## 上一轮的用户答复', last.command] : []),
    '',
    '## 上次执行的完整输出',
    clipped,
    '',
    '## 用户这次的答复',
    reply,
    '',
    '按答复继续执行。答复没有覆盖到的待决问题：先办已明确的部分，结尾把仍未决的项重新逐条编号列出。',
  ].join('\n');
}
