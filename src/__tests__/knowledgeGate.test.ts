import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendAnswers, type Answer } from '../backfill.js';
import { activeOnly, type KnowledgeEntry } from '../knowledge.js';
import type { InteractionPort } from '../ports.js';
import { ensureRejectionEvidence, extractAcReport, latestReviewPath } from '../ticketRunner.js';
import type { OpenQuestion } from '../types.js';

const entry = (title: string, status?: string): KnowledgeEntry => ({
  title,
  kind: '踩坑',
  status,
  tags: [],
  symptom: '',
  cause: '',
  practice: 'x',
});

describe('activeOnly（知识状态门的注入过滤）', () => {
  it('只放行「生效」，滤掉「待审」与「已失效」', () => {
    const out = activeOnly([entry('a', '生效'), entry('b', '待审'), entry('c', '已失效')]);
    expect(out.map((e) => e.title)).toEqual(['a']);
  });

  it('状态门上线前的存量条目（无状态字段）视同生效', () => {
    const out = activeOnly([entry('legacy'), entry('b', '待审')]);
    expect(out.map((e) => e.title)).toEqual(['legacy']);
  });
});

/** 假端口：记录追问轮次，按脚本给答案 */
function fakePort(rounds: Answer[][]): { port: InteractionPort; asked: OpenQuestion[][] } {
  const asked: OpenQuestion[][] = [];
  const port: InteractionPort = {
    async askQuestions(_t, questions) {
      asked.push(questions);
      return rounds[asked.length - 1] ?? [];
    },
    async confirmGate() {
      return { approved: true };
    },
    async notify() {},
    close() {},
  };
  return { port, asked };
}

const QUESTIONS: OpenQuestion[] = [
  { id: 'AC-1', question: '打开首页应显示列表', options: ['通过', '不通过', '无法验证'], recommended: '通过', why: 'x' },
  { id: 'AC-2', question: '导出应含退款列', options: ['通过', '不通过', '无法验证'], recommended: '通过', why: 'x' },
];

describe('implement 修复轮的恢复能力', () => {
  const mkRepo = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fixr-'));

  it('latestReviewPath 取最大轮次；无评审文档返回 null', () => {
    const repo = mkRepo();
    const dir = path.join(repo, 'docs', 'pipeline', 'LS-1');
    fs.mkdirSync(dir, { recursive: true });
    expect(latestReviewPath(repo, 'LS-1')).toBeNull();
    fs.writeFileSync(path.join(dir, '30-review-r1.md'), 'x');
    fs.writeFileSync(path.join(dir, '30-review-r2.md'), 'x');
    expect(latestReviewPath(repo, 'LS-1')).toBe('docs/pipeline/LS-1/30-review-r2.md');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('extractAcReport 取「本阶段结论」节，超长截断，缺失返回 null', () => {
    const repo = mkRepo();
    const dir = path.join(repo, 'docs', 'pipeline', 'LS-1');
    fs.mkdirSync(dir, { recursive: true });
    expect(extractAcReport(repo, 'LS-1')).toBeNull();
    fs.writeFileSync(
      path.join(dir, '40-acceptance.md'),
      '---\nstage: acceptance\n---\n\n## 本阶段结论\n\n| AC | 结果 |\n|---|---|\n| AC-1 | PASS |\n\n## 关键决策及理由\n无\n',
      'utf-8',
    );
    const rep = extractAcReport(repo, 'LS-1');
    expect(rep).toContain('| AC-1 | PASS |');
    expect(rep).not.toContain('关键决策');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('appendAnswers 目标为 feedback.md 时自动创建（implement 回填通道），其他目标缺失仍大声失败', () => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(repo, 'docs', 'pipeline', 'LS-1'), { recursive: true });
    const answers: Answer[] = [{ id: 'Q1', question: '部署了吗', answer: '没有' }];
    appendAnswers(repo, 'LS-1', 'feedback.md', '实现阶段问答', answers);
    const content = fs.readFileSync(path.join(repo, 'docs', 'pipeline', 'LS-1', 'feedback.md'), 'utf-8');
    expect(content).toContain('实现阶段问答');
    expect(content).toContain('答：没有');
    expect(() => appendAnswers(repo, 'LS-1', '00-intake.md', '澄清问答', answers)).toThrow('回填目标不存在');
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe('ensureRejectionEvidence（验收驳回必须附失败现象）', () => {
  it('全通过时不追问', async () => {
    const { port, asked } = fakePort([]);
    const answers: Answer[] = [
      { id: 'AC-1', question: 'q', answer: '通过' },
      { id: 'AC-2', question: 'q', answer: '无法验证' },
    ];
    const out = await ensureRejectionEvidence(port, 'LS-1', QUESTIONS, answers);
    expect(asked).toHaveLength(0);
    expect(out).toEqual(answers);
  });

  it('不通过但带了现象时不追问', async () => {
    const { port, asked } = fakePort([]);
    const out = await ensureRejectionEvidence(port, 'LS-1', QUESTIONS, [
      { id: 'AC-1', question: 'q', answer: '不通过', note: '首页白屏，控制台报 404' },
    ]);
    expect(asked).toHaveLength(0);
    expect(out[0].note).toContain('白屏');
  });

  it('缺现象时追问，第二轮给出现象后合并', async () => {
    const { port, asked } = fakePort([[{ id: 'AC-1', question: 'q', answer: '不通过', note: '列表为空，接口返回 []' }]]);
    const out = await ensureRejectionEvidence(port, 'LS-1', QUESTIONS, [
      { id: 'AC-1', question: 'q', answer: '不通过' },
      { id: 'AC-2', question: 'q', answer: '通过' },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(1); // 只追问缺现象的那一项
    expect(asked[0][0].question).toContain('需补充失败现象');
    expect(out.find((a) => a.id === 'AC-1')?.note).toContain('接口返回');
    expect(out.find((a) => a.id === 'AC-2')?.answer).toBe('通过');
  });

  it('追问后改判「通过」也接受', async () => {
    const { port } = fakePort([[{ id: 'AC-1', question: 'q', answer: '通过', note: '重试后正常，误判' }]]);
    const out = await ensureRejectionEvidence(port, 'LS-1', QUESTIONS, [
      { id: 'AC-1', question: 'q', answer: '不通过' },
    ]);
    expect(out[0].answer).toBe('通过');
  });

  it('两轮都不给现象：不无限卡流程，补占位说明让修复轮先复现', async () => {
    const { port, asked } = fakePort([
      [{ id: 'AC-1', question: 'q', answer: '不通过' }],
      [{ id: 'AC-1', question: 'q', answer: '不通过' }],
    ]);
    const out = await ensureRejectionEvidence(port, 'LS-1', QUESTIONS, [
      { id: 'AC-1', question: 'q', answer: '不通过' },
    ]);
    expect(asked).toHaveLength(2);
    expect(out[0].answer).toBe('不通过');
    expect(out[0].note).toContain('先自行复现');
  });
});
