import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

/**
 * 节点级事件日志（append-only JSONL）。
 * 定位：审计与可观测性的权威记录——每个节点的开始/结束/人工输入/决策都在这里；
 * 工单快照（<ticket>.json）仍是断点恢复用的工作状态，两者互补。
 */

export type EventType =
  | 'ticket.created'
  | 'triage'
  | 'stage.start'
  | 'stage.end'
  | 'question.asked'
  | 'question.answered'
  | 'gate.asked'
  | 'gate.answered'
  | 'knowledge.stale'
  | 'human.message'
  | 'release'
  | 'amend'
  | 'rewind'
  | 'pause'
  | 'resume'
  | 'halt'
  | 'done'
  | 'error';

export interface PipelineEvent {
  ts: string;
  ticket: string;
  type: EventType;
  stage?: string;
  /** 一行人类可读描述，直接用于时间线渲染 */
  summary: string;
  payload?: Record<string, unknown>;
}

function eventFile(ticket: string): string {
  return path.join(dataDir(), `${ticket}.events.jsonl`);
}

type Listener = (e: PipelineEvent) => void;
const listeners: Listener[] = [];

/** 订阅事件（投影到多维表格等旁路消费者用）。监听器异常绝不影响主流程 */
export function onEvent(fn: Listener): void {
  listeners.push(fn);
}

export function appendEvent(e: Omit<PipelineEvent, 'ts'>): PipelineEvent {
  const full: PipelineEvent = { ts: new Date().toISOString(), ...e };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(eventFile(e.ticket), JSON.stringify(full) + '\n', 'utf-8');
  for (const l of listeners) {
    try {
      l(full);
    } catch {
      /* 旁路消费者失败不影响事件已落盘的事实 */
    }
  }
  return full;
}

export function readEvents(ticket: string): PipelineEvent[] {
  const f = eventFile(ticket);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as PipelineEvent];
      } catch {
        return []; // 单行损坏不影响整体可读性
      }
    });
}

/**
 * 上次运行是否在阶段中途被打断：最后一个 stage.start 之后再无终结事件（stage.end/halt/done/error）。
 * daemon 崩溃或重启会连带杀掉进行中的会话，且不会留下任何事件——工单从此静静停着没人知道
 * （实测 LS-013，2026-08-25：重启杀掉刚起跑 3 分钟的 clarify，13 小时后人工翻日志才发现）。
 * gate.asked / question.asked 都发生在 stage.end 之后，等人工不算中断。
 * 调用方须自行确认该工单当前没有 runner 在跑（daemon 刚启动时天然成立）。
 */
export function interruptedStage(events: PipelineEvent[]): string | null {
  let running: string | null = null;
  for (const e of events) {
    if (e.type === 'stage.start') running = e.stage ?? '?';
    else if (e.type === 'stage.end' || e.type === 'halt' || e.type === 'done' || e.type === 'error') running = null;
  }
  return running;
}

/**
 * 重启后已死的待答卡片：pending 状态在 daemon 进程内存里，重启即失效——
 * 飞书上的卡片还在、点了只会提示「已过期」，没人说的话用户会以为流水线还在等他
 * （实测 OP-001，2026-08-31：clarify 提了 4 问后 daemon 重启，卡片全部变哑）。
 * 判据：生命周期事件里最后一个是 question.asked / gate.asked（其后无应答、无阶段推进）。
 */
export function lostPendingCards(events: PipelineEvent[]): string | null {
  const lifecycle = new Set<EventType>([
    'question.asked',
    'question.answered',
    'gate.asked',
    'gate.answered',
    'stage.start',
    'stage.end',
    'halt',
    'done',
    'error',
    'resume',
  ]);
  const last = [...events].reverse().find((e) => lifecycle.has(e.type));
  if (!last || (last.type !== 'question.asked' && last.type !== 'gate.asked')) return null;
  // 时效护栏：7 天以上的死卡不再点名（实测 LS-011：作废工单的旧提问每次开机都被唠叨一遍）
  if (Date.now() - Date.parse(last.ts) > 7 * 86400000) return null;
  return last.summary;
}

const ICON: Record<EventType, string> = {
  'ticket.created': '🆕',
  triage: '🔀',
  'stage.start': '▶️',
  'stage.end': '✅',
  'question.asked': '❓',
  'question.answered': '💬',
  'gate.asked': '🚦',
  'gate.answered': '👤',
  'knowledge.stale': '🧹',
  'human.message': '🗣️',
  release: '🚀',
  amend: '✏️',
  rewind: '⏪',
  pause: '⏸️',
  resume: '▶️',
  halt: '⛔',
  done: '🏁',
  error: '⚠️',
};

function hhmm(ts: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 渲染最近 N 条为 markdown 时间线（飞书卡片可直接展示） */
export function timeline(ticket: string, limit = 20): string {
  const evs = readEvents(ticket);
  if (!evs.length) return '（暂无事件记录）';
  const shown = evs.slice(-limit);
  const head = evs.length > limit ? `_（共 ${evs.length} 条，显示最近 ${limit} 条）_\n` : '';
  return head + shown.map((e) => `${ICON[e.type] ?? '·'} \`${hhmm(e.ts)}\` ${e.summary}`).join('\n');
}

/** 工单成本合计（从 stage.end 事件累加，与快照台账互为校验） */
export function totalCost(ticket: string): number {
  return readEvents(ticket)
    .filter((e) => e.type === 'stage.end')
    .reduce((s, e) => s + (Number(e.payload?.costUsd) || 0), 0);
}

/**
 * 列出 data/ 下所有已知工单。
 * 必须按内容判定而不是按扩展名——data/ 里还有 bitable-index.json 这类基础设施文件，
 * 只看 .json 会把它们当成工单混进 /list。
 */
export function listTickets(): string[] {
  const dir = dataDir();
  if (!fs.existsSync(dir)) return [];
  const names = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.events.jsonl')) {
      names.add(f.slice(0, -'.events.jsonl'.length));
      continue;
    }
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as { ticket?: string; cursor?: string };
      if (snap.ticket === name && snap.cursor) names.add(name); // 工单快照的自证字段
    } catch {
      /* 不是合法快照就不是工单 */
    }
  }
  return [...names].sort();
}
