import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

/**
 * 需求池（设计稿 docs/design/2026-09-23-requirements-pool.md）：工单之前的持久对象。
 * 这里只放存储与纯函数；飞书交互与转工单在 src/daemon/reqFlow.ts。
 */

export type ReqStatus = '梳理中' | '待确认' | '待排期' | '已排期' | '已转工单' | '已交付' | '重复' | '搁置' | '不做';

/** 还没关闭的状态：/pool 列这些，查重也只比这些 */
export const OPEN_STATUSES: ReqStatus[] = ['梳理中', '待确认', '待排期', '已排期', '已转工单'];

export interface Requirement {
  id: string;
  project: string;
  /** 《需求说明》里的标题；出说明前是原话前 30 字 */
  title: string;
  /** 提出人 open_id */
  requester: string;
  chatId: string;
  /** 来源话题根：访谈在这里进行，交付也回这里 @ 提出人 */
  rootId: string;
  status: ReqStatus;
  /** 提出人原话 */
  raw: string;
  /** 最新一版《需求说明》全文 */
  brief?: string;
  splits?: string[];
  dupOf?: string;
  /** 搁置 / 不做 / 驳回时的理由 */
  note?: string;
  tickets: string[];
  /** 已闭环、已回推给提出人的工单（闭环事件可能重放，回推要幂等） */
  delivered?: string[];
  /** 访谈轮次（每跑一轮会话 +1） */
  rounds: number;
  createdAt: string;
  updatedAt: string;
  scheduledAt?: string;
  /** 待排期超期提醒过的时间（每条只提醒一次） */
  remindedAt?: string;
}

export const REQ_RE = /^REQ-\d{3,}$/;
/** 第几轮起要求必须出说明（设计稿 §5：最多问 3 轮） */
export const MAX_INTERVIEW_ROUNDS = 3;
/** 每项目同时在制的工单上限（拍板 2026-09-23） */
export const WIP_LIMIT = 2;
/** 超过这么久没有任何事件的工单不占在制名额：挂着没人答的单（LS-011 一挂 35 天）不能把队列永远堵死 */
export const WIP_STALE_MS = 7 * 24 * 3600_000;
/** 待排期超过这么久，提醒负责人一次 */
export const SCHEDULE_REMIND_MS = 14 * 24 * 3600_000;

const reqDir = (): string => path.join(dataDir(), 'requirements');
const reqFile = (id: string): string => path.join(reqDir(), `${id}.json`);

export function readReq(id: string): Requirement | null {
  try {
    const r = JSON.parse(fs.readFileSync(reqFile(id), 'utf-8')) as Requirement;
    return r?.id === id ? r : null;
  } catch {
    return null;
  }
}

export function listReqs(): Requirement[] {
  try {
    return fs
      .readdirSync(reqDir())
      .filter((f) => /^REQ-\d+\.json$/.test(f))
      .map((f) => readReq(f.slice(0, -5)))
      .filter((r): r is Requirement => !!r)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** 下一个编号：扫目录取最大值 +1（单进程写，不需要锁） */
export function nextReqId(existing: string[] = listReqs().map((r) => r.id)): string {
  const max = existing.reduce((m, id) => Math.max(m, Number(/^REQ-(\d+)$/.exec(id)?.[1] ?? 0)), 0);
  return `REQ-${String(max + 1).padStart(3, '0')}`;
}

export function saveReq(r: Requirement, now = Date.now()): Requirement {
  const next = { ...r, updatedAt: new Date(now).toISOString() };
  fs.mkdirSync(reqDir(), { recursive: true });
  fs.writeFileSync(reqFile(r.id), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export function createReq(
  init: Pick<Requirement, 'project' | 'requester' | 'chatId' | 'rootId' | 'raw'>,
  now = Date.now(),
  id = nextReqId(),
): Requirement {
  const at = new Date(now).toISOString();
  return saveReq({ ...init, id, title: oneLine(init.raw).slice(0, 30), status: '梳理中', tickets: [], rounds: 0, createdAt: at, updatedAt: at }, now);
}

export function findReqByTicket(ticket: string, all = listReqs()): Requirement | null {
  return all.find((r) => r.tickets.includes(ticket)) ?? null;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ── 《需求说明》解析 ─────────────────────────────────────────

export const BRIEF_HEADING = '# 需求说明';
/** 访谈判定「这事不用改代码」时输出的标记（设计稿 §2） */
export const NO_DEV_MARK = '【无需开发】';

export interface ParsedBrief {
  /** 从输出里截出来的说明正文（自 `# 需求说明` 起） */
  brief: string;
  title: string;
  splits: string[];
  dups: string[];
  /** 「口径已确认」节原文（不含标题行） */
  confirmed: string;
}

/** 按 `## 节名` 切节；节名只取到第一个括号或空白前，模板里的「（业务验收描述）」之类不影响匹配 */
function sections(brief: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = '';
  let buf: string[] = [];
  for (const line of brief.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (name) out.set(name, buf.join('\n').trim());
      name = h[1].split(/[（(\s]/)[0];
      buf = [];
    } else if (name) buf.push(line);
  }
  if (name) out.set(name, buf.join('\n').trim());
  return out;
}

/** 输出里有没有一份《需求说明》；有就解析出 daemon 要用的几项，没有返回 null（这一轮还在问问题） */
export function parseBrief(output: string): ParsedBrief | null {
  const at = output.search(/^# 需求说明\s*$/m);
  if (at < 0) return null;
  const brief = output.slice(at).trim();
  const secs = sections(brief);
  const title = oneLine(/^标题[:：]\s*(.+)$/m.exec(brief)?.[1] ?? '').slice(0, 40);
  const splits = (secs.get('建议拆分') ?? '')
    .split('\n')
    .map((l) => /^\s*(?:\d+[.、)）]|[①-⑩]|[-*])\s*(.+)$/.exec(l)?.[1]?.trim() ?? '')
    .filter((l) => l && !/^(无|不拆|不需要拆分)/.test(l));
  const dups = [...new Set((secs.get('疑似重复') ?? '').match(/REQ-\d{3,}/g) ?? [])];
  return { brief, title, splits, dups, confirmed: secs.get('口径已确认') ?? '' };
}

/**
 * 转工单时交给 startTicket 的 intake 上下文：整份说明 + 把「口径已确认」改写成 `## 澄清问答` 节。
 * clarify 的规则是「澄清问答里已答的问题视为定论，禁止重复提问」（pipeline-clarify SKILL.md L24），
 * 所以业务在梳理阶段定下的口径不会在工单里再被问一遍
 */
export function intakeContextOf(r: Requirement, split?: string): string {
  const parsed = r.brief ? parseBrief(r.brief) : null;
  const qa = parsed?.confirmed.trim();
  return [
    `以下来自需求 ${r.id} 的梳理结果，提出人已确认、负责人已排期${split ? `；本工单负责其中一项：「${split}」` : ''}。调研结论里的「事实」由梳理会话查得，写 PRD 前请用代码逐条核实，不要整段照搬。`,
    '',
    r.brief ?? r.raw,
    ...(qa && !/^无\s*$/.test(qa) ? ['', `## 澄清问答（需求梳理阶段，提出人已确认）`, '', qa] : []),
  ].join('\n');
}

/** 转工单时的需求原文（进 00-intake.md 的「需求原文」与工单话题根消息） */
export function ticketRequirementOf(r: Requirement, split?: string): string {
  return `来自需求 ${r.id}：${split ?? r.title}${split && r.title ? `（需求：${r.title}）` : ''}`;
}

// ── 在制计算 ─────────────────────────────────────────────

export interface TicketLoad {
  ticket: string;
  project?: string;
  closed: boolean;
  halted: boolean;
  /** 最近一次事件的时间（ms） */
  lastEventAt: number;
}

/** 某项目当前占名额的工单：未闭环、未挂起、7 天内有动静 */
export function wipOf(project: string, loads: TicketLoad[], now = Date.now()): string[] {
  return loads.filter((t) => t.project === project && !t.closed && !t.halted && now - t.lastEventAt <= WIP_STALE_MS).map((t) => t.ticket);
}

/** 排队中的需求按排期先后出队 */
export function queuedFor(project: string, all = listReqs()): Requirement[] {
  return all.filter((r) => r.project === project && r.status === '已排期').sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
}

/** 一条需求要建的工单数：拆分项还没建完的部分 */
export function remainingSplits(r: Requirement): Array<string | undefined> {
  const items: Array<string | undefined> = r.splits?.length ? r.splits : [undefined];
  return items.slice(r.tickets.length);
}

// ── 访谈提示词 ─────────────────────────────────────────────

/**
 * 访谈的系统部分（首轮拼在原话前面；续轮靠 resume 记得）。
 * 规则来源：clarify 的提问标准（SKILL.md L33-60）+ 调研里的论文结论——给固定槽位清单、每轮少问、填满即停、没说的写假设
 */
export function composeInterviewPrompt(r: Requirement, opts: { openReqs: Requirement[]; brief?: string; fromThread?: boolean }): string {
  const others = opts.openReqs.filter((o) => o.id !== r.id && o.project === r.project);
  return [
    `你现在是项目 ${r.project} 的需求分析师，正在帮提出人把一个需求梳理成《需求说明》（编号 ${r.id}）。这一步不写代码、不设计实现，只弄清「做什么、为什么、怎么算做好」。`,
    opts.fromThread ? '这个话题之前的对话就是需求的来龙去脉，把它当作访谈已经得到的信息。' : '',
    '',
    '## 要填满的槽位',
    '必填（问提出人）：',
    '1. 要解决的问题：现在的痛点、为什么是现在',
    '2. 谁用、现在怎么做：角色、频率、现在的替代办法',
    '3. 怎么算做好了：一句不含技术词的业务验收描述，业务方读了能自己判断过没过',
    '4. 范围：包括什么、明确不包括什么（涉及的平台 / 店铺 / SKU / 页面）',
    '5. 期望时间：有没有硬截止（大促、平台规则生效日）',
    '自查（你自己查，不问人）：',
    '- 口径与术语：业务名词具体指什么，对照术语表；有歧义才问',
    '- 能力定位：先读 docs/pipeline/system-map/index.md（没有就读代码），判断是扩展已有能力还是新建',
    '- 影响面：能用只读库量化的就查（涉及多少 SPU / 店 / 订单 / 用户），数字要写出处',
    `- 疑似重复：同项目还没关闭的需求——${others.length ? others.map((o) => `${o.id}「${o.title}」（${o.status}）`).join('；') : '目前没有'}`,
    '',
    '## 提问规则',
    '- 自己能查到的不问；每多问一个本可自答的问题，业务方就多一分负担',
    '- 每轮最多 3 个问题，编号 Q1、Q2…；每个问题给 ≥2 个选项，并写推荐答案和理由',
    '- 不问怎么实现（用什么表、改哪个接口）；只问业务取舍、优先级、口径',
    '- 提出人没亲口说的，一律写进「假设」，不许当成事实',
    `- 如果这件事根本不需要改代码（查数、导出、一次性分析），直接照办，并在回复第一行写「${NO_DEV_MARK}」`,
    '',
    '## 什么时候停',
    `必填槽位都有了答案（或第 ${MAX_INTERVIEW_ROUNDS} 轮到了），就只输出下面这份《需求说明》，别的都不要。还没齐就只问问题，不要输出半份说明。`,
    '',
    '```',
    BRIEF_HEADING,
    '标题：（≤30 字，业务语言）',
    '## 要解决的问题',
    '## 谁用、现在怎么做',
    '## 怎么算做好了（业务验收描述）',
    '## 范围',
    '含：…',
    '不含：…',
    '## 期望时间',
    '## 口径已确认',
    '- Q：… → 答：…（写提出人的原话或所选选项；没有就写「无」）',
    '## 能力定位',
    '## 调研结论',
    '事实：…（每条附出处：文件路径、SQL、链接）',
    '推测：…',
    '## 假设（提出人未确认）',
    '## 疑似重复',
    '（写 REQ 编号和理由；没有就写「无」）',
    '## 建议拆分',
    '1. …（每条是一张可以独立交付的工单；不用拆就只写一条）',
    '```',
    opts.brief ? `\n## 上一版需求说明（提出人要求修改，在它的基础上改）\n\n${opts.brief}` : '',
    '',
    `## 提出人原话\n${r.raw}`,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

/** 续轮追加：第 3 轮起逼出说明 */
export function roundNudge(r: Requirement): string {
  return r.rounds + 1 >= MAX_INTERVIEW_ROUNDS
    ? `\n\n（这是需求 ${r.id} 的第 ${r.rounds + 1} 轮访谈：这一轮必须输出完整的《需求说明》，还不清楚的写进「假设」，不要再提问。）`
    : '';
}

/** 需求池一览（/pool 与面板共用） */
export function renderPool(all: Requirement[], now = Date.now()): string {
  const open = all.filter((r) => OPEN_STATUSES.includes(r.status));
  if (!open.length) return '需求池是空的。提需求：`/req 一句话说想要什么`';
  const days = (iso: string) => Math.floor((now - Date.parse(iso)) / 86_400_000);
  const lines: string[] = [];
  for (const st of OPEN_STATUSES) {
    const rs = open.filter((r) => r.status === st);
    if (!rs.length) continue;
    lines.push(`**${st}**（${rs.length}）`);
    for (const r of rs) {
      lines.push(`- ${r.id}［${r.project}］${r.title}　${days(r.createdAt)} 天${r.tickets.length ? `　→ ${r.tickets.join('、')}` : ''}`);
    }
  }
  return lines.join('\n');
}
