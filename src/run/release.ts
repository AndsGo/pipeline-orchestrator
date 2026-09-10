import { appendAnswers } from '../backfill.js';
import { appendEvent } from '../events.js';
import { findOpenMr, gitlabApiFromEnv, mergeMr } from '../gitlab/release.js';
import { detectTicketBranch } from '../implementProgress.js';
import { checkMergeAgainstTarget, describeMergeCheck } from '../mergeCheck.js';
import { describeRelease, type PipelineProfile, releaseTargetBranch } from '../profile.js';
import { readSnapshot, saveTicket } from '../ticket.js';
import type { OpenQuestion } from '../types.js';
import { broadcast } from '../ports.js';
import { audienceOf, releaseLine } from '../voice.js';
import type { TicketRun } from './context.js';
import { askGate } from './gates.js';

/**
 * 上线环节（编排器原生步骤，由仓库 PIPELINE.md 的 release 开关启用）：
 * 上线审批卡（含 MR / 验收结论 / 待补验清单）→ merge-* 模式合并 MR，manual 模式等人点确认 → 上线后补验（没有测试环境时验收跳过的人工项）。
 * 返回 'halt' 表示已挂起（驳回或合并失败），调用方 continue 让挂起分支接手。
 */
export async function runRelease(run: TicketRun, profile: PipelineProfile): Promise<'done' | 'halt'> {
  const { repo, ticket, port, project } = run;
  const target = releaseTargetBranch(profile.release);
  const api = gitlabApiFromEnv();
  const branch = run.state.branch ?? detectTicketBranch(repo, ticket) ?? null;
  const mr = api && project?.gitlab && branch ? await findOpenMr(api, project.gitlab, branch) : null;
  // 合并前先拉目标分支最新代码干跑一次：有冲突不合并、不发卡，交给人在分支上解决后「继续」
  const preCheck = target && branch ? checkMergeAgainstTarget(repo, branch, target) : null;
  if (preCheck && preCheck.ok === false) {
    run.state = {
      ...run.state,
      haltedReason: `${describeMergeCheck(preCheck, target!)}。请在分支 ${branch} 上合并 origin/${target} 解决冲突并推送，然后在群里说「继续 ${ticket}」`,
    };
    run.save();
    return 'halt';
  }
  if (!run.state.releaseApproved) {
    const acc = [...run.state.runs].reverse().find((r) => r.stage === 'acceptance');
    const checks = run.state.postReleaseChecks ?? [];
    const summary = [
      `**上线方式**：${describeRelease(profile.release)}`,
      `**分支**：${branch ?? '未探测到'}${mr ? `　**MR**：${mr.webUrl}（→ ${mr.targetBranch}）` : '　MR：未找到开着的 MR'}`,
      preCheck ? `**冲突预检**：${describeMergeCheck(preCheck, target!)}` : '',
      `**验收结论**：${acc ? (acc.verdict ?? acc.status) : '无验收记录'}`,
      checks.length
        ? `**上线后待补验 ${checks.length} 项**（项目无测试环境，验收时未能实测）：\n${checks.map((q) => `- ${q.id} ${q.question.split('\n')[0].slice(0, 80)}`).join('\n')}`
        : '',
      profile.sections['release'] ? `**项目上线约定**：\n${profile.sections['release'].slice(0, 600)}` : '',
      '',
      target
        ? `通过 → 编排器合并 MR 到 ${target}${mr ? '' : '（当前找不到开着的 MR，通过后需你手动合并）'}；驳回 → 不上线，工单挂起`
        : '本项目为人工上线：完成上线后点「通过」，编排器进入上线后补验与知识沉淀；驳回 → 不上线，工单挂起',
    ]
      .filter((l) => l !== '')
      .join('\n');
    run.state = { ...run.state, pendingGate: { gate: 'release-approval', summary, concerns: [], stage: 'acceptance' } };
    run.save();
    await askGate(run, run.state.pendingGate!);
    if (run.state.haltedReason) return 'halt';
    run.state = { ...run.state, releaseApproved: true };
    run.save();
  }
  if (target) {
    // 审批到合并之间可能过了很久，目标分支又前进了：合并前再复查一次
    const recheck = branch ? checkMergeAgainstTarget(repo, branch, target) : null;
    if (recheck && recheck.ok === false) {
      run.state = {
        ...run.state,
        haltedReason: `合并前复查：${describeMergeCheck(recheck, target)}。请在分支 ${branch} 上合并 origin/${target} 解决冲突并推送，然后在群里说「继续 ${ticket}」（不会重发审批卡）`,
      };
      run.save();
      return 'halt';
    }
    if (api && project?.gitlab && mr) {
      const r = await mergeMr(api, project.gitlab, mr.iid);
      if (!r.ok) {
        run.state = { ...run.state, haltedReason: `自动合并 MR !${mr.iid} → ${target} 失败：${r.message}。请手动合并后在群里说「继续 ${ticket}」` };
        run.save();
        return 'halt';
      }
      appendEvent({ ticket, type: 'release', summary: `已合并 MR !${mr.iid} → ${target}（${r.sha.slice(0, 8)}）` });
      await broadcast(
        port,
        ticket,
        audienceOf(profile) === 'business' ? releaseLine(target, mr.webUrl) : `已合并 MR !${mr.iid} → ${target}：${mr.webUrl}`,
      );
    } else {
      appendEvent({ ticket, type: 'release', summary: `人工合并 ${branch ?? '工单分支'} → ${target}（无可用 MR 或未配 GitLab API）` });
      await port.notify(
        ticket,
        `未找到可自动合并的 MR${api ? '' : '（未配置 GITLAB_URL/GITLAB_API_TOKEN）'}，请手动把 ${branch ?? '工单分支'} 合入 ${target}。流水线按已上线继续`,
      );
    }
  } else {
    appendEvent({ ticket, type: 'release', summary: '人工上线已确认' });
  }
  run.state = { ...run.state, released: true };
  run.save();
  return 'done';
}

/**
 * 上线后补验（没有测试环境的项目，验收时跳过的人工项）：卡异步挂着，**不阻塞** compound——
 * 运营要等模块升级才能答，可能是几天，知识沉淀不能跟着等。答复到了写回 40-acceptance.md 并清掉待办；
 * 重启丢卡时状态里的待办仍在，「继续」重发。
 */
export async function askPostReleaseChecks(run: TicketRun, checks: OpenQuestion[]): Promise<void> {
  const { repo, ticket, port } = run;
  appendEvent({ ticket, type: 'question.asked', stage: 'acceptance', summary: `上线后补验 ${checks.length} 项：${checks.map((q) => q.id).join(', ')}` });
  try {
    const answers = await port.askQuestions(ticket, checks.map((q) => ({ ...q, question: `【上线后补验】${q.question}` })));
    appendAnswers(repo, ticket, '40-acceptance.md', '上线后补验结果', answers);
    for (const a of answers) {
      appendEvent({ ticket, type: 'question.answered', stage: 'acceptance', summary: `${a.id} → ${a.answer.slice(0, 60)}${a.note ? `｜补充：${a.note.slice(0, 60)}` : ''}` });
    }
    const bad = answers.filter((a) => /不通过/.test(a.answer));
    if (bad.length) {
      await port.notify(ticket, `⚠ 上线后补验有 ${bad.length} 项不通过（${bad.map((a) => a.id).join('、')}），已记入 40-acceptance.md。修复请发 /new 新建工单并引用本单`);
    }
    // 只清待办，不动别的字段：runner 可能已经跑到别处，盘上以它为准
    const disk = readSnapshot(ticket) ?? run.state;
    run.state = { ...run.state, postReleaseChecks: [] };
    saveTicket({ ...disk, postReleaseChecks: [] });
  } catch (e) {
    appendEvent({ ticket, type: 'error', stage: 'acceptance', summary: `上线后补验卡异常：${(e as Error).message.slice(0, 200)}` });
  }
}
