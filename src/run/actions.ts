import fs from 'node:fs';
import path from 'node:path';
import { appendAnswers, type Answer } from '../backfill.js';
import { ticketDir } from '../config.js';
import { appendEvent } from '../events.js';
import { appendFeedback, feedbackRelPath, FEEDBACK_FILE } from '../feedback.js';
import type { InteractionPort } from '../ports.js';
import type { PipelineProfile } from '../profile.js';
import { previewUrl } from '../prototype.js';
import type { Action, OpenQuestion, Stage, StageResult } from '../types.js';
import { deliverAndCompound, reviewKnowledge, reviewStaleHints, reviewSuggestions, reviewTerms } from './compound.js';
import type { TicketRun } from './context.js';
import { askGate } from './gates.js';

/**
 * 验收「不通过」必须附失败现象——它是修复轮最重要的输入，缺了修复只能瞎猜。
 * 缺现象时重新发起确认（最多两轮）；人坚持不给就标明缺口，不无限卡流程。
 */
export async function ensureRejectionEvidence(
  port: InteractionPort,
  ticket: string,
  questions: OpenQuestion[],
  answers: Answer[],
): Promise<Answer[]> {
  let current = answers;
  for (let round = 0; round < 2; round++) {
    const missing = current.filter((a) => a.answer.trim() === '不通过' && !a.note?.trim());
    if (!missing.length) return current;
    const reask = missing
      .map((a) => questions.find((q) => q.id === a.id))
      .filter((q): q is OpenQuestion => !!q)
      .map((q) => ({
        ...q,
        question: `${q.question}\n\n【需补充失败现象】上一轮判「不通过」但没有描述现象。请重新作答，并在补充说明里写清：实际观察到什么、与预期差在哪。`,
      }));
    if (!reask.length) return current;
    await port.notify(ticket, `「不通过」必须附失败现象（修复轮据此定位问题），已重新发起 ${reask.length} 项确认`);
    const redo = await port.askQuestions(ticket, reask);
    current = current.map((a) => redo.find((r) => r.id === a.id) ?? a);
  }
  return current.map((a) =>
    a.answer.trim() === '不通过' && !a.note?.trim()
      ? { ...a, note: '（验收人未描述失败现象；修复轮请先自行复现，确认现象后再动手）' }
      : a,
  );
}

/** done：沉淀收尾（建议人审 → 交付文档 + 知识投影 → 知识/术语人审）并宣告闭环 */
async function actDone(run: TicketRun, res: StageResult): Promise<void> {
  const { repo, ticket, port, project } = run;
  // compound 的结论此前被通知逻辑丢弃（只有卡点阶段消费 summary_for_card），人根本不知道有教训沉淀
  if (res.summary_for_card) await port.notify(ticket, `沉淀结论：${res.summary_for_card}`);
  await reviewSuggestions(repo, ticket, port);
  const kb = await deliverAndCompound(repo, ticket, port, project);
  await reviewKnowledge(repo, ticket, port, kb.createdKnowledge, kb.updatedKnowledge);
  await reviewTerms(repo, ticket, port);
  // 本单各阶段标「待复核」的历史知识：闭环时一张卡定夺失效/恢复，答完即清（否则重进 runner 会再问一遍）
  await reviewStaleHints(ticket, port, run.state.staleHints);
  if (run.state.staleHints?.length) {
    run.state = { ...run.state, staleHints: undefined };
    run.save();
  }
  const total = run.state.runs.reduce((s, r) => s + r.costUsd, 0);
  appendEvent({ ticket, type: 'done', summary: `闭环：${run.state.runs.length} 次会话，$${total.toFixed(2)}` });
  await port.notify(ticket, `流水线闭环。共 ${run.state.runs.length} 次会话，合计 $${total.toFixed(2)}`);
}

/** gate：prd-confirm 先生成结果预览；先落盘 pendingGate 再弹卡 */
async function actGate(run: TicketRun, action: Extract<Action, { kind: 'gate' }>, stage: Stage): Promise<void> {
  const { repo, ticket, port } = run;
  let gateSummary = action.summary;
  // 结果预览（grill-me 定稿 2026-09-01）：prd-confirm 是决策质量最差的一环——业务人员面对
  // 大段文字只能盲点通过。确认卡弹出前用 sonnet 生成一页可看的原型（UI 可点/数据样例表/流程图），
  // 失败不阻塞卡点；驳回回 clarify 后下次进卡点自动重生成（原型永远是定稿 PRD 的投影）
  if (action.gate === 'prd-confirm') {
    await port.notify(ticket, '正在生成结果预览（1~3 分钟），随 PRD 确认卡一起发出…');
    const p = await run.prototype(repo, ticket);
    if (p.ok) {
      const url = previewUrl(ticket);
      gateSummary = `${
        url
          ? `📱 **结果预览**：${url}\n（示意非承诺，页内附验收标准清单）`
          : `📱 结果预览已生成：docs/pipeline/${ticket}/prototype/index.html（配置 PREVIEW_BASE_URL 后卡片将带可点链接）`
      }\n\n${gateSummary}`;
      // 成本入账：记为 clarify 的附属会话（extraArgs 标注来源），看板成本才不撒谎
      run.state = {
        ...run.state,
        runs: [
          ...run.state.runs,
          { stage: 'clarify', extraArgs: 'prototype', startedAt: new Date().toISOString(), costUsd: p.costUsd, turns: p.turns, status: 'DONE', sessionId: 'prototype' },
        ],
      };
      run.save();
    } else {
      await port.notify(ticket, `结果预览生成失败（不影响确认，PRD 材料齐全）：${p.note ?? '未知原因'}`);
    }
    // 可发现性（grill-me 问题 5 的缺口）：业务人员不知道卡片按钮之外可以直接说话
    gateSummary += '\n\n_按钮之外有任何意见，直接在群里说即可：小的记进需求，大的会回澄清重做。_';
  }
  // 先落盘再弹卡：卡随进程内存消失，盘上的这条记录是重启后重发它的唯一依据
  run.state = { ...run.state, pendingGate: { gate: action.gate, summary: gateSummary, concerns: action.concerns, stage } };
  run.save();
  await askGate(run, run.state.pendingGate!);
}

/** ask（NEEDS_CONTEXT）：弹问题卡或（无测试环境的验收人工项）记「无法验证」留到上线后，答复回填工件 + feedback */
async function actAsk(run: TicketRun, action: Extract<Action, { kind: 'ask' }>, stage: Stage, profile: PipelineProfile | null): Promise<void> {
  const { repo, ticket, port } = run;
  appendEvent({
    ticket,
    type: 'question.asked',
    stage,
    summary: `${action.questions.length} 个待确认问题：${action.questions.map((q) => q.id).join(', ')}`,
  });
  // 没有测试环境（PIPELINE.md testEnv: none）：验收的人工项无法实测，不弹卡让人猜——记「无法验证」并存起来，上线后再弹
  const skipManual = stage === 'acceptance' && profile !== null && profile.testEnv === null;
  // 有测试环境：把地址与登录说明写在每个问题最前面，验收人不用再问「去哪看」
  const questions =
    stage === 'acceptance' && profile?.testEnv
      ? action.questions.map((q) => ({
          ...q,
          question: `【验收环境】${profile.testEnv!.url}${profile.testEnv!.note ? `（${profile.testEnv!.note}）` : ''}\n\n${q.question}`,
        }))
      : action.questions;
  let answers = skipManual
    ? action.questions.map((q) => ({
        id: q.id,
        question: q.question,
        answer: '无法验证',
        note: '项目无测试环境（docs/pipeline/PIPELINE.md testEnv: none），转上线后补验',
      }))
    : await port.askQuestions(ticket, questions);
  if (skipManual) {
    run.state = { ...run.state, postReleaseChecks: [...(run.state.postReleaseChecks ?? []), ...action.questions] };
    run.save();
    await port.notify(ticket, `验收的 ${action.questions.length} 个人工项（${action.questions.map((q) => q.id).join('、')}）因本项目无测试环境暂记「无法验证」，上线后会再弹卡补验`);
  } else if (stage === 'acceptance') {
    answers = await ensureRejectionEvidence(port, ticket, action.questions, answers);
  }
  appendAnswers(repo, ticket, action.backfillTarget, action.backfillHeader, answers);
  for (const a of answers) {
    appendEvent({
      ticket,
      type: 'question.answered',
      stage,
      summary: `${a.id} → ${a.answer.slice(0, 60)}${a.note ? `｜补充：${a.note.slice(0, 60)}` : ''}`,
    });
  }
  // 人的补充说明同时进 feedback，供本阶段重跑时作为约束读取
  const notes = answers.filter((a) => a.note?.trim());
  if (notes.length) {
    const fb = appendFeedback(
      repo,
      ticket,
      `${stage} 问答补充说明`,
      notes.map((a) => `- ${a.id}（答：${a.answer}）：${a.note}`).join('\n'),
    );
    run.extraArgs = `feedback=${fb}`;
  }
}

/** fix：拼修复轮的 fix=（+feedback=）并持久化，暂停/重启不丢 findings 指针 */
function actFix(run: TicketRun, action: Extract<Action, { kind: 'fix' }>): void {
  const { repo, ticket } = run;
  // 人在群里补充的说明（feedback.md）对修复轮同样有约束力：验收只答"不通过"时，现象往往只写在这里
  const fb = path.join(ticketDir(repo, ticket), FEEDBACK_FILE);
  run.extraArgs = `fix=${action.findingsPath}${fs.existsSync(fb) ? ` feedback=${feedbackRelPath(ticket)}` : ''}`;
  run.state = { ...run.state, pendingExtraArgs: run.extraArgs };
  run.save();
}

/**
 * 按状态机给出的动作推进。返回 'return' 表示工单已闭环、runner 退出；'continue' 回到循环顶部
 * （halt 只落 haltedReason，由循环顶部的挂起分支处置）。
 */
export async function dispatchAction(
  run: TicketRun,
  action: Action,
  res: StageResult,
  stage: Stage,
  profile: PipelineProfile | null,
): Promise<'continue' | 'return'> {
  switch (action.kind) {
    case 'done':
      await actDone(run, res);
      return 'return';
    case 'halt':
      run.state = { ...run.state, haltedReason: action.reason };
      run.save();
      return 'continue';
    case 'gate':
      await actGate(run, action, stage);
      return 'continue';
    case 'ask':
      await actAsk(run, action, stage, profile);
      return 'continue';
    case 'fix':
      actFix(run, action);
      return 'continue';
    case 'run':
      return 'continue';
  }
}
