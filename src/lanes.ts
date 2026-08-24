import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';
import { runClaudeJson } from './runner.js';

/**
 * P0 任务分级：分诊器（Haiku 一次调用）+ 快车道（单会话直接实现）。
 * 快车道自带升级出口：会话发现超出小改动范围 → ESCALATE → 编排器降级回全流水线。
 */

export type Lane = 'fast' | 'full';

/** 快车道会话模型（导出供工单落账记录用——每条运行记录都要能说清用了什么模型） */
export const FASTLANE_MODEL = 'sonnet';

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lane', 'reason'],
  properties: {
    lane: { type: 'string', enum: ['fast', 'full'] },
    reason: { type: 'string', maxLength: 300 },
  },
} as const;

export function buildTriagePrompt(intake: string): string {
  return [
    '你是流水线分诊器。判断下述需求走哪条通道，只做判断不做实现：',
    '- fast：单点改动、低风险、无业务歧义、现有测试或简单验证即可背书（改文案/配置/单函数小修/明确的小 bug）',
    '- full：涉及业务决策或歧义、跨模块、新增功能面、有安全/数据风险、需要验收标准的',
    '拿不准一律 full——分诊错成 full 只是多花流程，错成 fast 会漏掉评审和验收。',
    '',
    '--- 需求原文 ---',
    intake,
  ].join('\n');
}

export async function runTriage(repo: string, ticket: string): Promise<{ lane: Lane; reason: string; costUsd: number }> {
  const intake = fs.readFileSync(path.join(ticketDir(repo, ticket), '00-intake.md'), 'utf-8');
  const { envelope } = await runClaudeJson({
    cwd: repo,
    prompt: buildTriagePrompt(intake),
    tools: 'Read,Grep,Glob', // 允许快速瞄一眼代码现状
    model: 'haiku',
    maxTurns: 8,
    budgetUsd: 0.5,
    schema: TRIAGE_SCHEMA,
  });
  const so = envelope.structured_output as unknown as { lane: Lane; reason: string } | undefined;
  // 分诊失败不阻塞：默认 full（保守方向）
  if (!so?.lane) return { lane: 'full', reason: '分诊无返回，保守走全流水线', costUsd: envelope.total_cost_usd ?? 0 };
  return { lane: so.lane, reason: so.reason, costUsd: envelope.total_cost_usd };
}

export const FASTLANE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary_for_card'],
  properties: {
    status: { type: 'string', enum: ['DONE', 'ESCALATE', 'BLOCKED'] },
    summary_for_card: { type: 'string', maxLength: 500 },
    branch: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
  },
} as const;

export interface FastlaneResult {
  status: 'DONE' | 'ESCALATE' | 'BLOCKED';
  summary_for_card: string;
  branch?: string | null;
  reason?: string | null;
}

export function buildFastlanePrompt(ticket: string): string {
  return [
    `读 docs/pipeline/${ticket}/00-intake.md 的需求。这是分诊为"小改动"的快车道任务：`,
    `0. 若存在 docs/pipeline/${ticket}/05-knowledge-hints.md，**先读它**——那是本项目历史踩过的坑，与本次改动相关的必须避开`,
    `1. 在新分支 feat/${ticket}-fast 上直接实现（分支已存在则续用）；禁止在 main/master 上改动`,
    '2. 有可运行的测试先写/先跑：修 bug 先写复现测试；至少运行受影响模块的既有测试并确认通过',
    '3. 完成即 commit（Conventional Commits），status=DONE，summary 说清改了什么、测试证据',
    '4. 动手后发现任一情况 → 停止、不再改动、status=ESCALATE：涉及业务取舍或歧义 / 要动 3 个以上模块 / 有安全或数据风险 / 需要业务方定验收标准',
    '5. 环境不可用（依赖装不上等）→ status=BLOCKED，reason 写明',
    '升级不是失败——错误地硬干完一个该走全流程的需求才是。',
  ].join('\n');
}

export async function runFastlane(repo: string, ticket: string): Promise<{ result: FastlaneResult; costUsd: number; turns: number }> {
  const { envelope } = await runClaudeJson({
    cwd: repo,
    prompt: buildFastlanePrompt(ticket),
    tools: 'Read,Grep,Glob,Write,Edit,Bash',
    model: FASTLANE_MODEL,
    maxTurns: 60,
    budgetUsd: 5,
    schema: FASTLANE_SCHEMA,
  });
  const so = (envelope.structured_output as unknown as FastlaneResult | undefined) ?? {
    status: 'BLOCKED' as const,
    summary_for_card: '快车道会话无结构化返回',
    reason: envelope.result ?? '未知',
  };
  return { result: so, costUsd: envelope.total_cost_usd ?? 0, turns: envelope.num_turns ?? 0 };
}
