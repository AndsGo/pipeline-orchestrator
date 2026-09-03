import type { RunOutcome, TextRunOpts } from '../runner.js';
import type { Stage } from '../types.js';

/**
 * 执行引擎：编排器与「谁来跑会话」之间的唯一接口。
 * 编排器只认 Envelope（is_error / num_turns / total_cost_usd / session_id / structured_output / result），
 * 阶段用什么 CLI、怎么传 schema、怎么算钱，全在引擎实现里。今天有 claude（原生）与 codex（桥接），
 * 项目在 PIPELINE.md 里用 `engine:` / `engine.<stage>:` 选。
 */
export interface TextResult {
  text: string;
  costUsd: number;
  turns: number;
  isError: boolean;
  sessionId?: string;
}

export interface Engine {
  readonly name: string;
  /** 跑一个流水线阶段（阶段 skill），返回结构化 Envelope */
  runStage(repo: string, ticket: string, stage: Exclude<Stage, 'ci'>, extraArgs?: string, modelOverride?: string): Promise<RunOutcome>;
  /** 自由文本会话（/run、续聊、原型生成、需求草拟） */
  runText(opts: TextRunOpts): Promise<TextResult>;
}
