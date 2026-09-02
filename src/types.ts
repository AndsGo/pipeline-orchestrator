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
  /** review 定稿的双轴清点（Spec 轴 + 质量轴，两轴永不合并排序） */
  axes?: {
    spec: { total: number; failed: number; worst: string | null };
    quality: { critical: number; important: number; minor: number; worst: string | null };
  } | null;
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
  /**
   * 本次会话实际使用的模型。没有它，任何「换了模型之后是好了还是坏了」的问题都只能靠
   * 「运行时间 × config.ts 的 git 历史」去反推——2026-08-24 排 implement 对照实验时
   * 才发现这条链是断的。缺失 = 该记录早于本字段（不是「用了默认模型」，别替历史数据下结论）。
   */
  model?: string;
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
  /**
   * 本工单的真实分支，implement 跑完后从 git 探测得到（如 feat/LS-012-org-call-monitor）。
   * 分支名由实现会话按计划的 Global Constraints 自己取（`feat/<工单号>-<slug>`），
   * 编排器事先猜不出来——此前看板按 `feat/<工单号>` 拼，拼出来的分支从未存在过。
   */
  branch?: string;
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
  /**
   * implement 主会话的模型，首次进入 implement 时冻结（对照实验的分组键）。
   * 冻结而不是每次读环境变量：一个工单的 implement 会分多批 + 修复轮跑好几次会话，
   * 中途换臂（改环境变量、重启 daemon）会让这一单变成混合臂，数据废掉。
   */
  implementModel?: string;
  /**
   * 已弹出、尚未得到答复的卡点。applyResult 在弹卡之前就把游标推到了下一阶段，进程一重启，
   * 卡随内存消失而游标已在后头——「继续」会直接跑下一阶段，卡点被无声跳过
   * （OP-002 实测 2026-09-02：plan-approval 没人答，盘上 cursor 已是 implement）。
   * 有它在，重进 runner 先原样重发这张卡：不重跑产出它的阶段，更不跳过它。答复落地即清。
   */
  pendingGate?: { gate: GateName; summary: string; concerns: string[]; stage: Stage };
  runs: RunRecord[];
  haltedReason?: string;
}

export type GateName = 'prd-confirm' | 'plan-approval' | 'deploy-approval';

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
  | { kind: 'gate'; gate: GateName; summary: string; concerns: string[]; then: Stage }
  | { kind: 'fix'; findingsPath: string; reverify: 'review' | 'acceptance' }
  | { kind: 'halt'; reason: string }
  | { kind: 'done' };
