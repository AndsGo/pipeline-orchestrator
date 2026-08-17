import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Stage } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** pipeline-plugin 位置：默认与本服务平级，可用环境变量覆盖 */
export const PLUGIN_DIR =
  process.env.PIPELINE_PLUGIN_DIR ?? path.resolve(here, '../../pipeline-plugin');

export const SCHEMA_PATH = path.join(PLUGIN_DIR, 'schemas', 'stage-result.schema.json');

export interface StageConfig {
  tools: string;
  model: string;
  maxTurns: number;
  budgetUsd: number;
}

/** claude 执行阶段的运行配置（ci 为编排器原生阶段，不在此表）——数值来自 LS-001 试跑的实测校准 */
export const STAGES: Record<Exclude<Stage, 'ci'>, StageConfig> = {
  clarify: { tools: 'Read,Grep,Glob,Write,Edit', model: 'sonnet', maxTurns: 60, budgetUsd: 8 },
  plan: { tools: 'Read,Grep,Glob,Write,Edit', model: 'opus', maxTurns: 80, budgetUsd: 10 },
  implement: {
    tools: 'Read,Grep,Glob,Write,Edit,Bash,Task,Agent,TodoWrite,Skill',
    model: 'opus',
    maxTurns: 300,
    budgetUsd: 25,
  },
  review: { tools: 'Read,Grep,Glob,Write,Bash', model: 'opus', maxTurns: 100, budgetUsd: 10 },
  acceptance: { tools: 'Read,Grep,Glob,Write,Edit,Bash', model: 'sonnet', maxTurns: 80, budgetUsd: 8 },
  compound: { tools: 'Read,Grep,Glob,Write,Bash', model: 'sonnet', maxTurns: 60, budgetUsd: 5 },
};

/** 同一 finding 来源打回 implement 的轮数上限，超限转人工 */
export const FIX_ROUND_CAP = 2;

/** NEEDS_CONTEXT 回答的回填目标与标题（相对 docs/pipeline/<ticket>/） */
export const BACKFILL: Partial<Record<Stage, { target: string; header: string }>> = {
  clarify: { target: '00-intake.md', header: '澄清问答' },
  // 实现（尤其修复轮）也会缺人工信息——如"验收环境部署的是哪个分支"。回填进 feedback.md（§8 约束性反馈通道）
  implement: { target: 'feedback.md', header: '实现阶段问答' },
  acceptance: { target: '40-acceptance.md', header: '人工验收结果' },
};

export function ticketDir(repo: string, ticket: string): string {
  return path.join(repo, 'docs', 'pipeline', ticket);
}
