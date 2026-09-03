import type { ImplementProgress } from '../implementProgress.js';
import type { InteractionPort } from '../ports.js';
import type { Project } from '../projects.js';
import { generatePrototype } from '../prototype.js';
import { engineFor } from '../engine/index.js';
import type { runStage } from '../runner.js';
import { saveTicket } from '../ticket.js';
import type { RunTicketOpts } from '../ticketRunner.js';
import { TRANSIENT_RETRY_DELAY_MS } from '../transient.js';
import type { Stage, TicketState } from '../types.js';

/**
 * 一次 runTicket 生命周期的上下文：工单状态 + 端口 + 注入的外部效应 + 只活在本进程里的几个标记。
 * 各环节（卡点 / 上线 / 动作分发 / 开工准备 / 挂起处理）都从这里读写 state，改完调 save() 落盘。
 */
export class TicketRun {
  readonly repo: string;
  readonly ticket: string;
  readonly port: InteractionPort;
  readonly project?: Project;
  readonly stageRunner: typeof runStage;
  readonly prototype: typeof generatePrototype;
  readonly transientRetryDelayMs: number;

  state: TicketState;
  /** 下一次阶段调用要带的参数（fix=/base=/feedback=）；用掉即清 */
  extraArgs: string;

  // 挂起重试卡每次 runner 生命周期只发一次：确定性失败不该变成无限重试循环（AutoPort 会自动放行）
  offeredRetry = false;
  // 评审仲裁卡同样只发一次：AutoPort 自动放行时最多追加一轮修复，不能变成 BLOCK→修复的无限循环
  offeredArbitration = false;
  // 瞬时 API 故障的自动重试：每个阶段一次
  readonly retriedTransient = new Set<Stage>();
  // implement 分批续做：上一批开工前的进展基线 + 本进程已自动续跑的批次数（判据见 implementProgress.ts）
  implementBefore: ImplementProgress | undefined;
  autoContinued = 0;
  // 上线后补验卡每个 runner 生命周期只异步弹一次
  postReleaseAsked = false;

  constructor(
    readonly opts: RunTicketOpts,
    state: TicketState,
  ) {
    this.repo = opts.repo;
    this.ticket = opts.ticket;
    this.port = opts.port;
    this.project = opts.project;
    // 缺省按仓库的流程约定选引擎（engine / engine.<stage>），每次调用时读——中途改 PIPELINE.md 下一阶段就生效
    this.stageRunner = opts.stageRunner ?? ((repo, ticket, stage, extraArgs, model) => engineFor(repo, stage).runStage(repo, ticket, stage, extraArgs, model));
    this.prototype = opts.prototype ?? generatePrototype;
    this.transientRetryDelayMs = opts.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
    this.state = state;
    // 续跑时恢复上次未用掉的阶段参数（暂停/重启不能丢掉修复轮的 findings 指针）
    this.extraArgs = state.pendingExtraArgs ?? '';
  }

  save(): void {
    saveTicket(this.state);
  }

  /** claude 会话并发闸门（daemon 模式下限流） */
  async withGate<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.opts.acquire ? await this.opts.acquire() : null;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }
}
