import type { PipelineEvent } from '../events.js';
import type { TicketState } from '../types.js';
import { STAGE_CN } from './schema.js';

/**
 * 投影：工单快照 + 事件 → 多维表格行（纯函数，可单测）。
 * 事件日志是事实源，表格是只读投影——所以这里只做映射，不做任何判断性写回。
 */

export interface ProjectCfg {
  /** GitLab 基址，用于把工件相对路径拼成可点链接 */
  gitlabUrl?: string;
  /** 本地仓库路径 → GitLab 项目路径（GITLAB_REPO_MAP 的反向） */
  repoToProject?: Record<string, string>;
}

const ms = (iso: string): number => new Date(iso).getTime();

export function stageLabel(stage?: string): string {
  return stage ? (STAGE_CN[stage] ?? stage) : '—';
}

/** 工件相对路径 → GitLab blob 链接；无法解析时返回 null（宁可留空也不写死链接） */
export function artifactUrl(cfg: ProjectCfg, state: TicketState | null, relPath?: string): string | null {
  if (!relPath || !cfg.gitlabUrl || !state) return null;
  const key = Object.keys(cfg.repoToProject ?? {}).find(
    (k) => normalize(k) === normalize(state.mainRepo ?? state.repo) || normalize(k) === normalize(state.repo),
  );
  const proj = key ? cfg.repoToProject![key] : undefined;
  if (!proj) return null;
  const branch = branchOf(state);
  return `${cfg.gitlabUrl.replace(/\/$/, '')}/${proj}/-/blob/${branch}/${relPath}`;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

export function branchOf(state: TicketState | null): string {
  if (!state) return 'HEAD';
  const impl = state.runs.find((r) => r.stage === 'implement');
  return impl ? `feat/${state.ticket}` : (state.lane === 'fast' ? `feat/${state.ticket}-fast` : `feat/${state.ticket}`);
}

/** 运行状态：快照里没有这个字段，由游标与挂起原因推导 */
export function runState(state: TicketState, isActive: boolean): string {
  if (state.haltedReason) return '挂起';
  if (state.cursor === 'compound' && state.runs.some((r) => r.stage === 'compound' && r.status === 'DONE')) return '闭环';
  return isActive ? '在跑' : '等人工';
}

/** 当前阶段：闭环后显示「已闭环」而不是停在沉淀 */
export function currentStage(state: TicketState): string {
  const done = state.runs.some((r) => r.stage === 'compound' && r.status === 'DONE');
  if (done) return '已闭环';
  return stageLabel(state.lane === 'fast' && state.runs.length === 0 ? 'fast' : state.cursor);
}

/** 「当前在等」：给看板一眼看出卡在哪 */
export function waitingOn(state: TicketState, events: PipelineEvent[]): string {
  if (state.haltedReason) return `挂起：${state.haltedReason.slice(0, 120)}`;
  const last = [...events].reverse().find((e) => ['question.asked', 'gate.asked', 'stage.start', 'stage.end', 'done'].includes(e.type));
  if (!last) return '';
  if (last.type === 'question.asked') return last.summary;
  if (last.type === 'gate.asked') return last.summary;
  if (last.type === 'stage.start') return `${stageLabel(last.stage)} 会话进行中`;
  if (last.type === 'done') return '';
  return `${stageLabel(last.stage)} 已完成，待推进`;
}

export function requirementOf(events: PipelineEvent[]): string {
  const created = events.find((e) => e.type === 'ticket.created');
  return created ? created.summary.replace(/^工单建立：/, '') : '';
}

/** 工单行字段 */
export function ticketRow(
  state: TicketState,
  events: PipelineEvent[],
  cfg: ProjectCfg,
  isActive: boolean,
): Record<string, unknown> {
  const cost = state.runs.reduce((s, r) => s + (r.costUsd || 0), 0);
  const first = events[0]?.ts ?? state.runs[0]?.startedAt;
  const row: Record<string, unknown> = {
    工单号: state.ticket,
    项目: state.project ?? '',
    需求: requirementOf(events).slice(0, 900),
    当前阶段: currentStage(state),
    运行状态: runState(state, isActive),
    通道: state.lane === 'fast' ? '快车道' : '全流水线',
    当前在等: waitingOn(state, events).slice(0, 500),
    累计成本USD: Number(cost.toFixed(2)),
    会话数: state.runs.length,
    评审回环: state.reviewFixRounds,
    验收回环: state.acceptanceFixRounds,
    分支: branchOf(state),
    最后更新: Date.now(),
  };
  if (first) row['开始时间'] = ms(first);
  const dir = artifactUrl(cfg, state, `docs/pipeline/${state.ticket}`);
  if (dir) row['工件目录'] = { text: `docs/pipeline/${state.ticket}`, link: dir };
  return row;
}

export interface NodeRow {
  /** 幂等键：同一事件重复投影不产生重复行 */
  key: string;
  fields: Record<string, unknown>;
}

const PROJECTED: PipelineEvent['type'][] = [
  'stage.end',
  'gate.answered',
  'question.answered',
  'halt',
  'done',
  'rewind',
  'amend',
  'triage',
];

/** 事件 → 节点行；不投影的事件返回 null */
export function nodeRow(
  ev: PipelineEvent,
  state: TicketState | null,
  cfg: ProjectCfg,
  roundOf: (stage: string) => number,
): NodeRow | null {
  if (!PROJECTED.includes(ev.type)) return null;
  const stage = stageLabel(ev.stage);
  const p = (ev.payload ?? {}) as { costUsd?: number; turns?: number; handoff?: string };

  const isStage = ev.type === 'stage.end';
  const round = isStage && ev.stage ? roundOf(ev.stage) : 0;
  // 人工回答按题区分，否则一轮 8 题会产生 8 条同名记录
  const qid = ev.type === 'question.answered' ? (/\b(Q\d+)\b/.exec(ev.summary)?.[1] ?? '') : '';
  const label = isStage
    ? `${ev.ticket} · ${stage}${round > 1 ? ` · 第${round}轮` : ''}`
    : `${ev.ticket} · ${nodeKindCn(ev.type)}${qid ? ` ${qid}` : ''}${ev.stage ? `（${stage}）` : ''}`;

  const fields: Record<string, unknown> = {
    记录: label,
    工单号: ev.ticket,
    项目: state?.project ?? '',
    阶段: ev.stage ? stage : '—',
    时间: ms(ev.ts),
  };
  if (isStage) {
    fields['轮次'] = round;
    fields['结果'] = matchOption(ev.summary, ['DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED', 'DONE']) ?? '—';
    fields['结论'] = matchOption(ev.summary, ['PASS_WITH_SUGGESTIONS', 'BLOCK', 'PASS']) ?? '—';
    fields['摘要'] = ev.summary.slice(0, 900);
    if (typeof p.costUsd === 'number') fields['成本USD'] = Number(p.costUsd.toFixed(2));
    if (typeof p.turns === 'number') fields['轮数'] = p.turns;
    const u = artifactUrl(cfg, state, p.handoff);
    if (u && p.handoff) fields['产物'] = { text: p.handoff.split('/').pop() ?? p.handoff, link: u };
  } else {
    fields['人工决策'] = ev.summary.slice(0, 900);
    fields['结果'] = '—';
    fields['结论'] = '—';
  }
  return { key: eventKey(ev), fields };
}

/**
 * 幂等键必须含摘要指纹：同一毫秒内可能落多条同类事件
 * （一轮 8 题的人工回答实测写在 1-2ms 内），只用 时间+类型 会把它们塌成一条，静默丢掉人的决策。
 */
export function eventKey(ev: PipelineEvent): string {
  return `${ev.ticket}|${ev.ts}|${ev.type}|${fingerprint(ev.summary)}`;
}

function fingerprint(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function nodeKindCn(t: PipelineEvent['type']): string {
  return (
    {
      'gate.answered': '卡点决策',
      'question.answered': '人工回答',
      halt: '挂起',
      done: '闭环',
      rewind: '回退',
      amend: '需求变更',
      triage: '分诊',
    } as Record<string, string>
  )[t] ?? t;
}

/** 从摘要里挑出枚举值：长选项优先，避免 DONE 抢先匹配 DONE_WITH_CONCERNS */
function matchOption(summary: string, options: string[]): string | null {
  return options.find((o) => summary.includes(o)) ?? null;
}
