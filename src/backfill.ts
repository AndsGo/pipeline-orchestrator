import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';
import type { OpenQuestion } from './types.js';

export interface Answer {
  id: string;
  question: string;
  answer: string;
  note?: string;
}

/** 把人工回答按试跑验证过的格式追加进工件；轮次号 = 已有同名标题数 + 1 */
export function appendAnswers(
  repo: string,
  ticket: string,
  target: string,
  header: string,
  answers: Answer[],
): string {
  const file = path.join(ticketDir(repo, ticket), target);
  if (!fs.existsSync(file)) throw new Error(`回填目标不存在：${file}`);
  const existing = fs.readFileSync(file, 'utf-8');
  const round = (existing.match(new RegExp(`^## ${header}`, 'gm'))?.length ?? 0) + 1;
  const date = new Date().toISOString().slice(0, 10);

  const lines = [``, `## ${header}（${date}，第 ${round} 轮）`, ``];
  for (const a of answers) {
    lines.push(`**${a.id}: ${a.question.split('\n')[0]}**`);
    lines.push(`答：${a.answer}${a.note ? `（备注：${a.note}）` : ''}`);
    lines.push('');
  }
  fs.appendFileSync(file, lines.join('\n'), 'utf-8');
  return file;
}

export function questionSummary(qs: OpenQuestion[]): string {
  return qs
    .map((q) => `${q.id}. ${q.question}\n   推荐：${q.recommended}（${q.why}）`)
    .join('\n');
}
