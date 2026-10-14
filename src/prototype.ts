import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR, ticketDir } from './config.js';
import { engineFor } from './engine/index.js';
import type { ExecutionSnapshot } from './engine/configuration.js';
import { CliExecutionError } from './engine/errors.js';

/**
 * 结果预览（grill-me 质询定稿，2026-09-01）：prd-confirm 是决策质量最差的一环——
 * 业务人员面对大段文字 PRD 实际上只能盲点通过（LS-013/OP-001 的确认都是秒过）。
 * clarify 定稿后、确认卡弹出前，用 sonnet 单独生成一页业务可看的 HTML：
 * UI 需求 → 可点原型；数据需求 → 假数据样例表；规则需求 → 流程图+实例。
 * 三条铁律：原型永不独立迭代（它只是 PRD 的投影，意见走卡点驳回回 clarify）；
 * 页顶「示意非承诺」横幅 + 页底 AC 清单同框；生成失败不阻塞确认卡。
 */

export function prototypeFile(repo: string, ticket: string): string {
  return path.join(ticketDir(repo, ticket), 'prototype', 'index.html');
}

/** 业务人员点开的地址：webhook 服务的只读静态路由（PREVIEW_BASE_URL 如 http://10.0.x.x:8377） */
export function previewUrl(ticket: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.PREVIEW_BASE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/preview/${ticket}/` : null;
}

export interface PrototypeResult {
  ok: boolean;
  costUsd: number;
  turns: number;
  costStatus?: import('./cost.js').CostStatus;
  sessionId?: string;
  execution?: ExecutionSnapshot;
  note?: string;
}

/** CLI/configuration failures remain explicit; a successful call without an artifact returns ok:false. */
export async function generatePrototype(repo: string, ticket: string, execution?: ExecutionSnapshot): Promise<PrototypeResult> {
  try {
    const r = await engineFor(repo, 'prototype', execution).runText({
      cwd: repo,
      prompt: `/pipeline-prototype ${ticket}`,
      tools: 'Read,Grep,Glob,Write,Edit,Bash',
      model: 'sonnet',
      maxTurns: 40,
      budgetUsd: 3,
      pluginDir: PLUGIN_DIR,
    });
    const ok = fs.existsSync(prototypeFile(repo, ticket));
    return { ok, costUsd: r.costUsd, turns: r.turns, costStatus: r.costStatus, sessionId: r.sessionId, execution: r.execution, note: ok ? undefined : (r.text || '').slice(0, 160) };
  } catch (e) {
    if (e instanceof CliExecutionError) throw e;
    throw new Error(`原型执行失败：${(e as Error).message}`);
  }
}
