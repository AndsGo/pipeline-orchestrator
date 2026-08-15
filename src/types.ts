export type Stage = 'clarify' | 'plan' | 'implement' | 'review' | 'ci' | 'acceptance' | 'compound';

export type Status = 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_CONTEXT' | 'BLOCKED';

export type Verdict = 'PASS' | 'PASS_WITH_SUGGESTIONS' | 'BLOCK' | null;

export interface OpenQuestion {
  id: string;
  question: string;
  options?: string[];
  recommended: string;
  why: string;
}

/** skill 的结构化返回，schema 见 pipeline-plugin/schemas/stage-result.schema.json */
export interface StageResult {
  stage: Stage;
  status: Status;
  handoff_path: string;
  summary_for_card: string;
  open_questions?: OpenQuestion[];
  concerns?: string[];
  blocked_reason?: string | null;
  verdict?: Verdict;
}

/** claude -p --output-format json 的信封（只声明编排需要的字段） */
export interface Envelope {
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  session_id: string;
  structured_output?: StageResult;
  permission_denials: unknown[];
  result?: string;
}

export interface RunRecord {
  stage: Stage | 'triage' | 'fast';
  extraArgs: string;
  startedAt: string;
  costUsd: number;
  turns: number;
  status: Status;
  verdict?: Verdict;
  sessionId: string;
}

export interface TicketState {
  ticket: string;
  repo: string;
  /** 下一个要跑的阶段 */
  cursor: Stage;
  /** review 打回 implement 的已用轮数 */
  reviewFixRounds: number;
  /** acceptance 打回 implement 的已用轮数 */
  acceptanceFixRounds: number;
  /** implement 处于修复模式时，修完后应回到哪个阶段复验 */
  pendingReverify: 'review' | 'acceptance' | null;
  /** 首次 implement 前的 HEAD（分支切出点），review 用作 diff 基点 */
  baseSha?: string;
  /** 建单时是否配置了 Jenkins（决定 review 通过后走 ci 还是直达 acceptance），随工单固化 */
  ciEnabled?: boolean;
  /** 分诊结果：fast=快车道单会话；full=全流水线。快车道 ESCALATE 后改写为 full */
  lane?: 'fast' | 'full';
  /** 所属项目别名（决定 CI 任务、Wiki 归档节点、知识范围） */
  project?: string;
  /** 主仓库路径（repo 可能是并行工单的 worktree） */
  mainRepo?: string;
  isWorktree?: boolean;
  /** 待执行的回退：由 amend/rewind 指令设置，runner 在下一个阶段边界应用 */
  pendingRewind?: { to: Stage; reason: string; feedbackPath?: string };
  /** 下一次阶段调用要带的参数（如 fix=/base=）。必须持久化——否则暂停或重启会把修复轮的 findings 指针丢掉 */
  pendingExtraArgs?: string;
  runs: RunRecord[];
  haltedReason?: string;
}

export type Action =
  | { kind: 'run'; stage: Stage; extraArgs?: string }
  | {
      kind: 'ask';
      questions: OpenQuestion[];
      /** 回答追加到哪个工件（相对工单目录） */
      backfillTarget: string;
      backfillHeader: string;
      thenRerun: Stage;
    }
  | { kind: 'gate'; gate: 'prd-confirm' | 'plan-approval' | 'deploy-approval'; summary: string; concerns: string[]; then: Stage }
  | { kind: 'fix'; findingsPath: string; reverify: 'review' | 'acceptance' }
  | { kind: 'halt'; reason: string }
  | { kind: 'done' };
