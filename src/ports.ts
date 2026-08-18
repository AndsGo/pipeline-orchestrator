import readline from 'node:readline/promises';
import type { Answer } from './backfill.js';
import type { OpenQuestion } from './types.js';

/** 卡点结果：通过与否 + 人的说明（驳回时说明会驱动重跑） */
export interface GateDecision {
  approved: boolean;
  note?: string;
}

/**
 * 交互端口抽象：CLI / 无人值守 / 飞书 三种实现。
 * 每个方法都必须允许人给出自由文本——只给选择题会让人失去表达能力。
 */
export interface InteractionPort {
  /** NEEDS_CONTEXT：逐题收集回答（含选填的补充说明） */
  askQuestions(ticket: string, questions: OpenQuestion[]): Promise<Answer[]>;
  /** 人工卡点：通过/驳回 + 说明。detail 为从工件提取的决策材料（AC 清单/任务拆分） */
  confirmGate(ticket: string, gate: string, summary: string, concerns: string[], detail?: string): Promise<GateDecision>;
  /** 单向通知 */
  notify(ticket: string, message: string): Promise<void>;
  /** 结构化报告（如验收 AC 结果表）：比 notify 长、要排版。可选——未实现的端口由调用方降级为 notify */
  sendReport?(ticket: string, title: string, markdown: string): Promise<void>;
  close(): void;
}

export class CliPort implements InteractionPort {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async askQuestions(ticket: string, questions: OpenQuestion[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    console.log(`\n[${ticket}] 需要补充信息（回车 = 采纳推荐答案）：`);
    for (const q of questions) {
      console.log(`\n${q.id}: ${q.question}`);
      if (q.options?.length) q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
      console.log(`  推荐：${q.recommended}\n  理由：${q.why}`);
      const raw = (await this.rl.question('> ')).trim();
      let answer = raw || q.recommended;
      const idx = Number(raw);
      if (q.options && Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) {
        answer = q.options[idx - 1];
      }
      const note = (await this.rl.question('补充说明（可留空）> ')).trim();
      answers.push({ id: q.id, question: q.question, answer, note: note || undefined });
    }
    return answers;
  }

  async confirmGate(ticket: string, gate: string, summary: string, concerns: string[], detail?: string): Promise<GateDecision> {
    console.log(`\n[${ticket}] 人工卡点：${gate}\n${summary}`);
    if (detail) console.log(`\n${detail}`);
    if (concerns.length) console.log(`concerns：\n${concerns.map((c) => `  - ${c}`).join('\n')}`);
    const raw = (await this.rl.question('通过？(y/n) > ')).trim().toLowerCase();
    const approved = raw === 'y' || raw === 'yes';
    const note = (await this.rl.question(approved ? '备注（可留空）> ' : '驳回原因（会驱动重跑）> ')).trim();
    return { approved, note: note || undefined };
  }

  async notify(ticket: string, message: string): Promise<void> {
    console.log(`\n[${ticket}] ${message}`);
  }

  async sendReport(ticket: string, title: string, markdown: string): Promise<void> {
    console.log(`\n[${ticket}] ${title}\n${markdown}`);
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * 无人值守端口：澄清问题采纳推荐答案；卡点自动放行（留痕）；
 * 验收类问题（options 含"无法验证"）诚实答"无法验证"留待人工补验，绝不冒充"通过"。
 */
export class AutoPort implements InteractionPort {
  async askQuestions(ticket: string, questions: OpenQuestion[]): Promise<Answer[]> {
    return questions.map((q) => {
      const unverifiable = q.options?.find((o) => o.includes('无法验证'));
      if (unverifiable) {
        console.log(`[${ticket}] ${q.id} 无人值守 → 无法验证（待人工补验）`);
        return { id: q.id, question: q.question, answer: unverifiable, note: '无人值守模式，待人工补验' };
      }
      console.log(`[${ticket}] ${q.id} 无人值守 → 采纳推荐：${q.recommended}`);
      return { id: q.id, question: q.question, answer: q.recommended, note: '无人值守模式，采纳推荐答案' };
    });
  }

  async confirmGate(ticket: string, gate: string, summary: string, concerns: string[], _detail?: string): Promise<GateDecision> {
    console.log(`[${ticket}] 卡点 ${gate} 无人值守自动放行。摘要：${summary.slice(0, 120)}…`);
    if (concerns.length) console.log(`  携带 concerns ${concerns.length} 条`);
    return { approved: true, note: '无人值守模式自动放行' };
  }

  async notify(ticket: string, message: string): Promise<void> {
    console.log(`[${ticket}] ${message}`);
  }

  close(): void {}
}
