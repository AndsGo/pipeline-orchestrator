import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';

/**
 * 人工反馈通道：把"人说的话"落成阶段会话读得到的文件。
 * 卡片驳回原因、需求追加、补充说明都写这里，重跑阶段时以 feedback=<path> 传入 prompt。
 * append-only：每一轮反馈都留痕，不覆盖。
 */

export const FEEDBACK_FILE = 'feedback.md';

export function feedbackRelPath(ticket: string): string {
  return `docs/pipeline/${ticket}/${FEEDBACK_FILE}`;
}

/** 追加一条反馈，返回仓库相对路径（用于 extraArgs 指针） */
export function appendFeedback(repo: string, ticket: string, kind: string, text: string, by = 'human'): string {
  const dir = ticketDir(repo, ticket);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FEEDBACK_FILE);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# ${ticket} 人工反馈\n\n> 本文件记录流程运行中人给出的修正、驳回理由与需求变更。\n> 阶段会话被传入 \`feedback=\` 时必须先读本文件，并把其中内容视为**具有约束力的人工指令**（优先级高于上游工件的旧结论）。\n`,
      'utf-8',
    );
  }
  fs.appendFileSync(file, `\n## [${new Date().toISOString()}] ${kind}（by ${by}）\n\n${text.trim()}\n`, 'utf-8');
  return feedbackRelPath(ticket);
}

/** 追加需求变更到 00-intake.md（需求本身的修改留在原始需求文件里） */
export function appendRequirementAmendment(repo: string, ticket: string, text: string, by = 'human'): void {
  const file = path.join(ticketDir(repo, ticket), '00-intake.md');
  if (!fs.existsSync(file)) throw new Error(`${file} 不存在，无法追加需求变更`);
  const round = (fs.readFileSync(file, 'utf-8').match(/^## 需求变更/gm)?.length ?? 0) + 1;
  fs.appendFileSync(
    file,
    `\n## 需求变更（第 ${round} 次，${new Date().toISOString()}，by ${by}）\n\n${text.trim()}\n\n> 以下变更优先于上文原始需求；如与既有 PRD/AC 冲突，以本节为准。\n`,
    'utf-8',
  );
}
