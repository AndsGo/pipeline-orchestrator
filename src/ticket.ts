import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jenkinsConfigFromEnv } from './jenkins.js';
import { ciJobFor, type Project } from './projects.js';
import type { Stage, TicketState } from './types.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

function stateFile(ticket: string): string {
  return path.join(DATA_DIR, `${ticket}.json`);
}

/** 只读快照（不校验 repo）：投影器与看板用 */
export function readSnapshot(ticket: string): TicketState | null {
  const f = stateFile(ticket);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as TicketState;
  } catch {
    return null;
  }
}

/** 只读窥探工单已绑定的工作目录（daemon 分配工作区前用，避免重复开 worktree） */
export function peekTicketRepo(ticket: string): string | null {
  const f = stateFile(ticket);
  if (!fs.existsSync(f)) return null;
  try {
    return (JSON.parse(fs.readFileSync(f, 'utf-8')) as TicketState).repo;
  } catch {
    return null;
  }
}

export function loadTicket(repo: string, ticket: string, startStage: Stage, project?: Project): TicketState {
  const f = stateFile(ticket);
  if (fs.existsSync(f)) {
    const s = JSON.parse(fs.readFileSync(f, 'utf-8')) as TicketState;
    if (path.resolve(s.repo) !== path.resolve(repo)) {
      throw new Error(`工单 ${ticket} 已绑定仓库 ${s.repo}，与传入的 ${repo} 不一致`);
    }
    return s;
  }
  return {
    ticket,
    repo,
    cursor: startStage,
    reviewFixRounds: 0,
    acceptanceFixRounds: 0,
    pendingReverify: null,
    // 建单时固化：是否走 CI 阶段（避免同一工单中途因环境变量变化而改变路径）。
    // 任务名按项目解析（ciJobFor）：多项目下没配自己 job 的项目不走 CI，绝不借全局 job
    ciEnabled: jenkinsConfigFromEnv(ciJobFor(project)) !== null,
    runs: [],
  };
}

export function saveTicket(state: TicketState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(stateFile(state.ticket), JSON.stringify(state, null, 2), 'utf-8');
}
