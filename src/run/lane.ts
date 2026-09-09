import fs from 'node:fs';
import path from 'node:path';
import { prefetchKnowledgeHints } from '../bitable/sync.js';
import { ticketDir } from '../config.js';
import { appendEvent } from '../events.js';
import { FASTLANE_MODEL, runFastlane, runTriage } from '../lanes.js';
import { readProfile } from '../profile.js';
import { audienceOf, triageLine } from '../voice.js';
import type { TicketRun } from './context.js';

/**
 * 分诊 + 快车道（P0 任务分级）。返回 true 表示工单已在快车道闭环，runner 应直接退出；
 * false 表示继续全流水线（新单分诊为 full、快车道 ESCALATE 降级、或快车道 BLOCKED 挂起交给挂起分支）。
 */
export async function triageAndFastlane(run: TicketRun): Promise<boolean> {
  const { repo, ticket, port, project, opts } = run;

  // 分诊：仅新工单（无运行记录、无既定通道）
  if (!run.state.lane && run.state.runs.length === 0) {
    if (opts.lane) {
      run.state = { ...run.state, lane: opts.lane };
      await port.notify(ticket, `通道由参数指定：${run.state.lane}`);
    } else {
      const t = await run.withGate(() => runTriage(repo, ticket));
      run.state = { ...run.state, lane: t.lane };
      appendEvent({ ticket, type: 'triage', summary: `分诊 ${t.lane}：${t.reason}`, payload: { costUsd: t.costUsd } });
      await port.notify(
        ticket,
        audienceOf(readProfile(repo)) === 'business'
          ? triageLine(t.lane, t.reason, t.costUsd)
          : `分诊：${t.lane === 'fast' ? '快车道（单会话直接实现）' : '全流水线'}——${t.reason}（$${t.costUsd.toFixed(2)}）`,
      );
    }
    run.save();
  }

  // 快车道：单会话实现，ESCALATE 自动降级回全流水线
  if (run.state.lane === 'fast') {
    // 快车道绕过计划直接改代码，如果不预取知识，它就没有任何通道能拿到既有踩坑经验
    const intake = path.join(ticketDir(repo, ticket), '00-intake.md');
    const n = await prefetchKnowledgeHints(
      repo,
      ticket,
      fs.existsSync(intake) ? fs.readFileSync(intake, 'utf-8') : '',
      project?.alias,
    );
    if (n) await port.notify(ticket, `已预取 ${n} 条历史知识提示供快车道参考`);
    appendEvent({ ticket, type: 'stage.start', stage: 'fast', summary: '快车道会话开始' });
    const { result, costUsd, turns } = await run.withGate(() => runFastlane(repo, ticket));
    run.state = {
      ...run.state,
      runs: [
        ...run.state.runs,
        {
          stage: 'fast',
          extraArgs: '',
          startedAt: new Date().toISOString(),
          costUsd,
          turns,
          status: result.status === 'DONE' ? 'DONE' : 'BLOCKED',
          sessionId: 'fastlane',
          model: FASTLANE_MODEL,
        },
      ],
    };
    appendEvent({
      ticket,
      type: 'stage.end',
      stage: 'fast',
      summary: `快车道 ${result.status}：${result.summary_for_card.slice(0, 120)}`,
      payload: { costUsd, turns },
    });
    if (result.status === 'DONE') {
      await port.notify(ticket, `快车道完成：${result.summary_for_card}${result.branch ? `（分支 ${result.branch}）` : ''}`);
      appendEvent({ ticket, type: 'done', summary: '快车道闭环' });
      run.save();
      return true;
    }
    if (result.status === 'ESCALATE') {
      run.state = { ...run.state, lane: 'full' };
      await port.notify(ticket, `快车道升级为全流水线：${result.reason ?? result.summary_for_card}`);
    } else {
      run.state = { ...run.state, haltedReason: `快车道 BLOCKED：${result.reason ?? result.summary_for_card}` };
    }
    run.save();
  }
  return false;
}
