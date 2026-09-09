import type { PipelineProfile } from './profile.js';
import type { Action, Stage, StageResult } from './types.js';

/**
 * 群消息的受众口吻。`it`（缺省）= 现状：状态码、sha、路径、轮数照发，给研发看。
 * `business` = 业务方看的版本：每条带「走到第几步」的锚、说人话、结尾一句「你要不要做什么」，
 * 不出现分支/路径/模型/状态码。只改编排器写死的模板——那是群里最技术化、又完全不花模型钱的一层
 * （LS-017 全程 60 多条群消息里，`review → DONE / BLOCK｜AC 13/14 · 质量 C0/I1/M0` 这类占大半）。
 * 阶段 skill 写的 summary_for_card / 问题文案的受众约束是第 2 步，不在这里。
 */
export type Audience = 'business' | 'it';

export const audienceOf = (p: PipelineProfile | null): Audience => p?.audience ?? 'it';

/** 业务方眼里的步骤序列：ci 是自动环节、沉淀是内部收尾，都不算「步」 */
const STEPS: Stage[] = ['clarify', 'plan', 'implement', 'review', 'acceptance'];
const STEP_CN: Record<string, string> = {
  clarify: '整理需求',
  plan: '制定方案',
  implement: '开发',
  review: '代码评审',
  acceptance: '验收',
  compound: '总结归档',
  ci: '自动测试',
};

/** 卡点名的业务叫法（卡片标题用，两种口吻都用——英文 gate 名对谁都不是信息） */
export const GATE_CN: Record<string, string> = {
  'prd-confirm': '需求确认',
  'plan-approval': '方案审批',
  'deploy-approval': '部署审批',
  'release-approval': '上线审批',
};
const GATE_ASK: Record<string, string> = {
  'prd-confirm': '确认需求文档',
  'plan-approval': '审批实施方案',
  'deploy-approval': '批准部署到测试环境',
  'release-approval': '批准上线',
};

const cn = (stage: string): string => STEP_CN[stage] ?? stage;

/** 状态锚：「验收 5/5」。群里几小时刷一次的人，每条消息都得能看出走到哪了 */
export function anchor(stage: string): string {
  const i = STEPS.indexOf(stage as Stage);
  return i < 0 ? cn(stage) : `${cn(stage)} ${i + 1}/${STEPS.length}`;
}

/** 「通常 7～15 分钟」——历史中位数放宽成区间；样本不足传 null 就不说 */
function typical(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 1.5) return '，通常 1～2 分钟';
  return `，通常 ${Math.max(1, Math.round(minutes * 0.7))}～${Math.round(minutes * 1.5)} 分钟`;
}

export function startLine(stage: string, extraArgs: string, typicalMinutes: number | null): string {
  let verb = `开始${cn(stage)}`;
  if (/(^|\s)fix=/.test(extraArgs)) verb = '开始修改评审指出的问题';
  else if (/(^|\s)feedback=/.test(extraArgs)) verb = `按你的补充重新${cn(stage)}`;
  return `${anchor(stage)} · ${verb}${typical(typicalMinutes)}，不用操作`;
}

/** 结尾一句：接下来谁做什么。没这一句，业务方看到「验收 → NEEDS_CONTEXT」不知道该不该动 */
export function nextActionLine(action: Action): string {
  switch (action.kind) {
    case 'gate':
      return `接下来需要你${GATE_ASK[action.gate] ?? '处理卡点'}——看下面的卡片`;
    case 'ask':
      return `有 ${action.questions.length} 个问题需要你回答——看下面的卡片`;
    case 'run':
      return `自动进入下一步：${cn(action.stage)}，不用操作`;
    case 'fix':
      return '自动发回开发修改，不用操作';
    case 'halt':
      return '流程已暂停，等人处理';
    case 'done':
      return '';
  }
}

export function endLine(res: StageResult, costUsd: number, action: Action): string {
  const money = `（$${costUsd.toFixed(2)}）`;
  let head: string;
  if (res.status === 'BLOCKED') {
    head = `${cn(res.stage)}卡住了：${(res.blocked_reason ?? '缺少必要输入').slice(0, 160)}`;
  } else if (res.status === 'NEEDS_CONTEXT') {
    head = `${cn(res.stage)}中有 ${res.open_questions?.length ?? 0} 个问题需要你确认`;
  } else if (res.stage === 'review') {
    const a = res.axes;
    if (a) {
      const issues = a.quality.critical + a.quality.important;
      if (res.verdict === 'BLOCK') {
        head = `评审：${a.spec.total} 条验收标准有 ${a.spec.failed} 条未满足${issues ? `、${issues} 个问题需修改` : ''}，发回修改`;
      } else {
        const tips = a.quality.minor + (res.verdict === 'PASS_WITH_SUGGESTIONS' ? a.quality.important : 0);
        head = `评审通过：${a.spec.total} 条验收标准全部满足${tips ? `，附 ${tips} 条建议` : ''}`;
      }
    } else head = res.verdict === 'BLOCK' ? '评审未通过，发回修改' : '评审通过';
  } else if (res.stage === 'acceptance') {
    head =
      res.verdict === 'BLOCK'
        ? '验收未通过，发回修改'
        : `验收通过${res.status === 'DONE_WITH_CONCERNS' ? '（有待补验项，见结果表）' : ''}`;
  } else {
    head = `${cn(res.stage)}完成`;
  }
  const next = nextActionLine(action);
  return `${anchor(res.stage)} · ${head}${money}${next ? `\n${next}` : ''}`;
}

/** implement 台账行 → 业务能懂的进度；认不出的（parked/BLOCKED 等研发术语）返回 null 不发 */
export function progressLine(text: string): string | null {
  const task = /Task\s*(\d+)\s*:\s*complete/i.exec(text);
  if (task) return `开发进度：第 ${task[1]} 项完成`;
  const round = /fix round\s*(\d+)/i.exec(text);
  if (round) return `开始第 ${round[1]} 轮修改`;
  return null;
}

export function triageLine(lane: string, reason: string, costUsd: number): string {
  const how = lane === 'fast' ? '小改动，直接开发' : '走完整流程（整理需求 → 制定方案 → 开发 → 评审 → 验收）';
  return `已受理：${how}——${reason}（$${costUsd.toFixed(2)}）`;
}

export function errorLine(stage: string, raw: string, ticket: string, retryMinutes: number | null): string {
  const why = raw.replace(/^会话异常：/, '').slice(0, 120);
  return retryMinutes !== null
    ? `${anchor(stage)} · 这一步出错了，${retryMinutes} 分钟后自动重试，不用操作。原因：${why}`
    : `${anchor(stage)} · 这一步出错了，没有产生结果。在群里说「继续 ${ticket}」可重试。原因：${why}`;
}

export const staleBlockWarning = (): string =>
  '⚠ 评审通过了，但上一轮评审指出的问题之后没有修改记录，可能漏检——批准上线前请让研发核对一下';

export const closeoutLine = (runs: number, totalUsd: number): string =>
  `✅ 全部完成并已归档。共 ${runs} 步，合计 $${totalUsd.toFixed(2)}`;

export const releaseLine = (target: string, url: string): string => `🚀 已上线（合并到 ${target}）：${url}`;
