import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Stage } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** pipeline-plugin 位置：默认与本服务平级，可用环境变量覆盖 */
export const PLUGIN_DIR =
  process.env.PIPELINE_PLUGIN_DIR ?? path.resolve(here, '../../pipeline-plugin');

export const SCHEMA_PATH = path.join(PLUGIN_DIR, 'schemas', 'stage-result.schema.json');

/** headless 会话的 --settings 覆盖：禁用与阶段 skill 抢流控的插件（保留 superpowers 与 CLAUDE.md 注入） */
export const RUNNER_SETTINGS = path.resolve(here, '../config/pipeline-settings.json');

export interface StageConfig {
  tools: string;
  model: string;
  maxTurns: number;
  budgetUsd: number;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 所有 headless 会话显式钉住的推理档位（三个启动点共用：runClaudeJson / runClaudeText / MR 评审）。
 *
 * 不钉的话各阶段隐式继承 ~/.claude/settings.json 的 effortLevel——那是给交互使用调的旋钮，
 * 人在 /config 里改一次，流水线行为跟着变而无人知晓，历次实测校准（下表的轮数与预算）随之失去可比性。
 * 取 high 是因为迄今全部校准数据都是在全局 high 下采集的：钉住 = 冻结现状，不是调参。
 *
 * 为什么走 CLI 的 --effort 而不是写进 config/pipeline-settings.json：`-p` 模式下**校验失败的
 * settings 文件会被静默忽略**（claude --help 原文），一旦这个键不被 schema 接受，同一文件里
 * 禁插件的 enabledPlugins 会一起失效，2026-08-18 修掉的双流控 bug 会无声回归。
 * 用带类型的联合而非裸字符串：拼错的档位只会换来一行 stderr 警告 + 静默回落默认档（实测），tsc 挡得住。
 */
export const STAGE_EFFORT: EffortLevel = 'high';

/** claude 执行阶段的运行配置（ci 为编排器原生阶段，不在此表）——数值来自 LS-001 试跑的实测校准 */
export const STAGES: Record<Exclude<Stage, 'ci'>, StageConfig> = {
  // 换 opus 的理由是这一阶段的产物（PRD 与 AC 清单）是下游全部阶段的地基，问错问题的代价
  // 一路放大到验收；轮数留 60 不动（实测最多 43 轮，opus 通常更少轮而非更多）。
  // 预算必须跟着模型走：sonnet 下最贵一次 $2.52（LS-012，24 轮），opus 单价 5 倍 ≈ $12.6，
  // 会顶穿旧的 $8；16 = 该值 + 余量（effort=high 的 opus 思考量更大）。
  // 只换模型不抬预算，约束就从「模型能力」搬到「钱不够」——与 plan 抬轮数那次同一个坑。
  clarify: { tools: 'Read,Grep,Glob,Write,Edit', model: 'opus', maxTurns: 60, budgetUsd: 16 },
  // 轮数是本阶段的实际约束：LS-004 的计划跑到 82 轮（旧上限 80，零余量）、成本只用掉 $7.76/10。
  // 120 轮按该次实测的 $0.095/轮换算约 $11.4，会顶穿旧的 $10——两个数必须一起抬，
  // 否则约束只是从轮数搬到预算，会话照样在半途死掉。
  plan: { tools: 'Read,Grep,Glob,Write,Edit', model: 'opus', maxTurns: 120, budgetUsd: 14 },
  // implement 的真实天花板是预算不是轮数：实测轮数最多 99（上限 300 从未接近），
  // 而 LS-008/009/012 三次分别花到 $21.24/$22.60/$22.31，都贴着 $25。
  // 预算不上调是刻意的：装不下的大计划由编排器自动续跑分批承接（IMPLEMENT_AUTO_CONTINUE_CAP，
  // 每批有台账 commit 和评审留痕），比放宽单会话额度更可控。要调请先看那条路径。
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

/** implement 主会话模型的对照实验臂 */
export const IMPLEMENT_MODEL_ARMS = ['opus', 'sonnet'] as const;

/**
 * implement 主会话该用哪个模型。
 *
 * 为什么要做对照：implement 现在是「主会话 opus + 子代理 haiku/sonnet 分层」，主会话干的是
 * 派活、读评审、仲裁，未必需要最强模型；但 LS-012 那种九任务计划的分批与仲裁质量如果掉下去，
 * 代价是评审回环变多——省下的钱会从修复轮里加倍还回来。所以只能实测，不能凭感觉钉。
 *
 * @param frozen 工单已冻结的实验臂（state.implementModel）。有就照用，保证同一单不混臂。
 * @returns note 非空表示这一单偏离了默认配置——必须发到群里，
 *   与 PIPELINE_HINTS_OFF 同一条纪律：静默的对照期会让指标比较变成无人知晓的暗箱。
 */
export function resolveImplementModel(frozen?: string): { model: string; note?: string } {
  if (frozen) return { model: frozen };
  const env = process.env.PIPELINE_IMPLEMENT_MODEL?.trim();
  if (!env) return { model: STAGES.implement.model };
  if (!(IMPLEMENT_MODEL_ARMS as readonly string[]).includes(env)) {
    return {
      model: STAGES.implement.model,
      note: `⚠ PIPELINE_IMPLEMENT_MODEL="${env}" 不是有效实验臂（${IMPLEMENT_MODEL_ARMS.join(' / ')}），本单按默认 ${STAGES.implement.model} 跑`,
    };
  }
  return {
    model: env,
    note: `对照实验：本单 implement 主会话用 ${env}（默认 ${STAGES.implement.model}），已随工单冻结，分批与修复轮都用它`,
  };
}

/**
 * implement 因执行余量用尽挂起时，编排器自动续跑下一批的次数上限（每个 runner 生命周期内计数）。
 * 5 批的来源：LS-012 的 9 任务计划，会话自己给的分批建议正好是五批。
 */
export const IMPLEMENT_AUTO_CONTINUE_CAP = 5;

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
