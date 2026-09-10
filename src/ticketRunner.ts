import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ticketDir } from './config.js';
import { appendEvent } from './events.js';
import { feedbackRelPath, FEEDBACK_FILE } from './feedback.js';
import { detectTicketBranch, resolveLedgerFile } from './implementProgress.js';
import { jenkinsConfigFromEnv, runJenkinsBuild } from './jenkins.js';
import type { Lane } from './lanes.js';
import { applyResult, mergeReviewResults, route, unconsumedReviewBlocks } from './machine.js';
import { isPaused } from './pause.js';
import type { InteractionPort } from './ports.js';
import { readProfile } from './profile.js';
import { ciJobFor, type Project } from './projects.js';
import type { generatePrototype } from './prototype.js';
import { dispatchAction } from './run/actions.js';
import { flagStaleHints, mergeStaleHints } from './run/compound.js';
import { TicketRun } from './run/context.js';
import { reaskPendingGate } from './run/gates.js';
import { handleHalted } from './run/halt.js';
import { triageAndFastlane } from './run/lane.js';
import { prepareStage } from './run/prep.js';
import { askPostReleaseChecks, runRelease } from './run/release.js';
import type { runStage } from './runner.js';
import { validateResult } from './schema.js';
import { loadTicket, readSnapshot, saveTicket } from './ticket.js';
import { isTransientApiError } from './transient.js';
import type { Envelope, Stage, StageResult, TicketState } from './types.js';
import { broadcast } from './ports.js';
import { type Audience, audienceOf, endLine as bizEndLine, errorLine, progressLine, staleBlockWarning } from './voice.js';

export { ensureRejectionEvidence } from './run/actions.js';

export interface RunTicketOpts {
  /** 工单实际工作目录（主仓库或 worktree） */
  repo: string;
  ticket: string;
  port: InteractionPort;
  /** 所属项目：决定 CI 任务、Wiki 归档节点、知识范围 */
  project?: Project;
  startStage?: Stage;
  requirement?: string;
  /** 建单前最近一次 /run 的排查记录，写进 00-intake.md 供澄清参考（见 followup.intakeContextFromLastRun） */
  intakeContext?: string;
  lane?: Lane;
  /** claude 会话并发闸门（daemon 模式下限流），返回释放函数 */
  acquire?: () => Promise<() => void>;
  /**
   * 以下三个是外部效应的注入点，缺省即线上行为（spawn claude / 真等 3 分钟）。
   * 集成测试用假引擎替换：OP-002 那次「卡点没人答、重启后游标已在下一阶段」的缺陷之所以能到生产，
   * 就是因为 runTicket 从来没有一条不起真会话就能跑完整个循环的路。
   */
  stageRunner?: typeof runStage;
  prototype?: typeof generatePrototype;
  /** 瞬时 API 故障自动重试前的等待（毫秒） */
  transientRetryDelayMs?: number;
}

/** 提取 40-acceptance.md 的「本阶段结论」（含 AC 结果总表），发给业务方逐条确认——替代一句「PASS」 */
export function extractAcReport(repo: string, ticket: string): string | null {
  const f = path.join(ticketDir(repo, ticket), '40-acceptance.md');
  if (!fs.existsSync(f)) return null;
  const m = /## 本阶段结论\s*([\s\S]*?)(?=\n## |$)/.exec(fs.readFileSync(f, 'utf-8'));
  const body = m?.[1]?.trim();
  if (!body) return null;
  return body.length > 2500 ? `${body.slice(0, 2500)}\n…（全文见 40-acceptance.md）` : body;
}

/** 最新一轮评审文档的仓库相对路径（重建修复轮 fix= 参数用） */
export function latestReviewPath(repo: string, ticket: string): string | null {
  try {
    const rounds = fs
      .readdirSync(ticketDir(repo, ticket))
      .map((f) => /^30-review-r(\d+)\.md$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]));
    return rounds.length ? `docs/pipeline/${ticket}/30-review-r${Math.max(...rounds)}.md` : null;
  } catch {
    return null;
  }
}

export function ensureIntake(repo: string, ticket: string, requirement?: string, context?: string): void {
  const dir = ticketDir(repo, ticket);
  const intake = path.join(dir, '00-intake.md');
  if (fs.existsSync(intake)) return;
  if (!requirement) {
    throw new Error(`${intake} 不存在。首次运行请提供需求原文（--requirement / 指令附带）`);
  }
  fs.mkdirSync(dir, { recursive: true });
  // context：建单前的 /run 排查记录（followup.intakeContextFromLastRun）。放 intake 而不是 note 事件：
  // note 的 summary 截断在 80 字，且 intake 是澄清阶段的必读件——结论跟着需求走才不会二次失散
  fs.writeFileSync(
    intake,
    `# ${ticket} 原始需求\n\n**来源**：编排器录入\n**录入时间**：${new Date().toISOString().slice(0, 10)}\n\n## 需求原文\n\n> ${requirement}\n${
      context ? `\n## 建单前的执行记录（自动附带，供参考）\n\n${context}\n` : ''
    }`,
    'utf-8',
  );
  appendEvent({ ticket, type: 'ticket.created', summary: `工单建立：${requirement.slice(0, 80)}` });
}

/**
 * implement 期间轮询 ledger，新出现的完成/回环/挂起行实时推送（20 秒粒度）。
 * 台账可能在 worktree 里（见 implementProgress.ts），开工时解析一次；
 * 本批次自己新建 worktree 的那次仍会漏推，下一批就跟上了。
 */
function watchLedger(repo: string, ticket: string, port: InteractionPort, audience: Audience = 'it'): { stop: () => void } {
  const file = resolveLedgerFile(repo, ticket);
  let seen = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').length : 0;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (const line of lines.slice(seen)) {
        if (/complete|fix round|BLOCKED|parked/i.test(line)) {
          const text = line.trim().slice(0, 200);
          appendEvent({ ticket, type: 'stage.start', stage: 'implement', summary: `进度：${text}` });
          // 业务口吻：台账行是研发术语（parked/BLOCKED/子代理模型），只把认得出的「第 N 项完成」翻成人话
          const said = audience === 'business' ? progressLine(text) : `进度：${text}`;
          if (said) void port.notify(ticket, said);
        }
      }
      seen = lines.length;
    } catch {
      /* 读失败跳过本轮 */
    }
  }, 20000);
  return { stop: () => clearInterval(timer) };
}

/** CI 阶段：编排器原生执行（触发 Jenkins → 等结果 → 记录 35-ci.md → 合成 StageResult） */
async function runCiStage(repo: string, ticket: string, port: InteractionPort, project?: Project): Promise<Envelope> {
  const artifact = path.join(ticketDir(repo, ticket), '35-ci.md');
  const relArtifact = `docs/pipeline/${ticket}/35-ci.md`;
  const synth = (res: StageResult): Envelope =>
    ({
      is_error: false,
      num_turns: 0,
      total_cost_usd: 0,
      session_id: 'jenkins',
      structured_output: res,
      permission_denials: [],
    }) as Envelope;

  const cfg = jenkinsConfigFromEnv(ciJobFor(project));
  if (!cfg) {
    return synth({
      stage: 'ci',
      status: 'BLOCKED',
      handoff_path: relArtifact,
      summary_for_card: 'CI 配置缺失',
      blocked_reason: `工单所属项目 ${project?.alias ?? '(未知)'} 没有配置 Jenkins 任务，或缺少 JENKINS_URL/USER/TOKEN`,
    });
  }
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim();
  await port.notify(ticket, `触发 Jenkins 任务 ${cfg.job}（BRANCH=${branch}）…`);
  const build = await runJenkinsBuild(cfg, { TICKET: ticket, BRANCH: branch }, fetch, (m) => void port.notify(ticket, m));

  if (!fs.existsSync(artifact)) fs.writeFileSync(artifact, `# ${ticket} CI 构建记录\n`, 'utf-8');
  fs.appendFileSync(
    artifact,
    `\n## 构建 ${build.buildNumber ?? '(未分配)'}（${new Date().toISOString()}）\n- 任务：${cfg.job}\n- 分支：${branch}\n- 结果：**${build.result}**\n- 地址：${build.buildUrl ?? '无'}\n` +
      (build.ok ? '' : `\n### 日志尾部\n\`\`\`\n${build.logTail}\n\`\`\`\n`),
    'utf-8',
  );

  return build.ok
    ? synth({
        stage: 'ci',
        status: 'DONE',
        handoff_path: relArtifact,
        summary_for_card: `Jenkins 构建 #${build.buildNumber} SUCCESS（${branch}），进入验收`,
      })
    : synth({
        stage: 'ci',
        status: 'BLOCKED',
        handoff_path: relArtifact,
        summary_for_card: `Jenkins 构建失败：${build.result}`,
        blocked_reason: `Jenkins #${build.buildNumber ?? '?'} ${build.result}（${build.buildUrl ?? ''}）。日志尾部见 ${relArtifact}，修复后 --start ci 重试`,
      });
}

/**
 * 单工单的完整生命周期（分诊 → 快车道/全流水线 → 闭环）。
 * cli.ts 与 daemon.ts 共用；daemon 用 acquire 限制并发 claude 会话数。
 *
 * 主循环每轮：回读盘上指令 → 回退 → 挂起处置（run/halt.ts）→ 暂停 → 重发待答卡点（run/gates.ts）
 * → 拼阶段参数 → 上线环节（run/release.ts）→ 开工准备（run/prep.ts）→ 跑阶段 → 异常/瞬时重试
 * → 路由落账 → 动作分发（run/actions.ts）。
 */
export async function runTicket(opts: RunTicketOpts): Promise<void> {
  const { repo, ticket, port, project } = opts;
  ensureIntake(repo, ticket, opts.requirement, opts.intakeContext);
  let state = loadTicket(repo, ticket, opts.startStage ?? 'clarify', project);
  if (project && state.project !== project.alias) {
    state = { ...state, project: project.alias }; // 项目归属随工单固化，后续阶段与投影都读它
    saveTicket(state);
  }
  const run = new TicketRun(opts, state);

  if (await triageAndFastlane(run)) return;

  for (;;) {
    // 指令通道会在会话运行期间直接改盘上的状态（暂停/回退/需求变更），
    // 而本 runner 手里是自己的内存副本——不回读就会在下次 saveTicket 时把人的指令悄悄覆盖掉。
    const disk = readSnapshot(ticket);
    if (disk?.pendingRewind && !run.state.pendingRewind) run.state = { ...run.state, pendingRewind: disk.pendingRewind };

    // 待执行回退（amend/rewind 指令）优先于一切：这是人的意志
    if (run.state.pendingRewind) {
      const { to, reason, feedbackPath } = run.state.pendingRewind;
      run.state = { ...run.state, cursor: to, pendingRewind: undefined, haltedReason: undefined };
      if (feedbackPath) run.extraArgs = `feedback=${feedbackPath}`;
      run.save();
      appendEvent({ ticket, type: 'rewind', stage: to, summary: `回退到 ${to}：${reason}` });
      await port.notify(ticket, `已回退到 ${to} 重跑（${reason}）`);
    }
    if (run.state.haltedReason) {
      if ((await handleHalted(run)) === 'return') return;
      continue;
    }
    if (isPaused(ticket)) {
      appendEvent({ ticket, type: 'pause', stage: run.state.cursor, summary: `在 ${run.state.cursor} 前暂停` });
      await port.notify(ticket, `已在安全点暂停（游标 ${run.state.cursor}）。恢复：群里说"继续 ${ticket}"或重跑 start-ticket`);
      return;
    }
    // 重启前弹出、没等到答复的卡点：原样重发。游标早已推到下一阶段，不拦在这里就等于人没审批直接开工
    if (run.state.pendingGate) {
      await reaskPendingGate(run, run.state.pendingGate);
      continue;
    }

    // 首次 implement 前记录分支切出点，review 阶段以此为 diff 基点
    if (run.state.cursor === 'implement' && !run.state.baseSha) {
      run.state = { ...run.state, baseSha: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim() };
      run.save();
    }
    if (run.state.cursor === 'review' && !run.extraArgs && run.state.baseSha) run.extraArgs = `base=${run.state.baseSha}`;
    // 修复轮的 fix= 参数在挂起/重启后已被消费——从 pendingReverify 重建，否则重进的 implement 不知道自己在修复模式
    if (run.state.cursor === 'implement' && !run.extraArgs && run.state.pendingReverify) {
      const src = run.state.pendingReverify === 'acceptance' ? `docs/pipeline/${ticket}/40-acceptance.md` : latestReviewPath(repo, ticket);
      const fb = path.join(ticketDir(repo, ticket), FEEDBACK_FILE);
      if (src) run.extraArgs = `fix=${src}${fs.existsSync(fb) ? ` feedback=${feedbackRelPath(ticket)}` : ''}`;
    }

    const stage = run.state.cursor;
    const profile = readProfile(repo);
    // 上线环节：compound 之前先过（上线审批 → 合并/人工上线 → 上线后补验）。驳回或合并失败 → 挂起分支接手
    if (stage === 'compound' && profile && profile.release !== 'none' && !run.state.released) {
      if ((await runRelease(run, profile)) === 'halt') continue;
    }
    // 上线后补验：已上线且有待办 → 异步弹卡（每个 runner 生命周期一次），不等答复；已闭环的工单进来只为重发这张卡
    if (run.state.released && run.state.postReleaseChecks?.length && !run.postReleaseAsked) {
      run.postReleaseAsked = true;
      void askPostReleaseChecks(run, run.state.postReleaseChecks);
      if (run.state.runs.some((r) => r.stage === 'compound' && r.status === 'DONE')) return;
    }

    const stageModel = await prepareStage(run, stage, profile);
    const ledgerWatch = stage === 'implement' ? watchLedger(repo, ticket, port, audienceOf(profile)) : null;
    let envelope: Envelope;
    try {
      envelope = await run.withGate(() =>
        stage === 'ci'
          ? runCiStage(repo, ticket, port, project)
          : run.stageRunner(repo, ticket, stage, run.extraArgs, stageModel).then((r) => r.envelope),
      );
    } finally {
      ledgerWatch?.stop();
    }

    // 双评审取严
    if (stage === 'review' && process.env.PIPELINE_DOUBLE_REVIEW === '1' && envelope.structured_output?.verdict) {
      await port.notify(ticket, '双评审模式：启动第二轮独立评审…');
      const second = await run.withGate(() => run.stageRunner(repo, ticket, 'review', run.extraArgs));
      if (second.envelope.structured_output?.verdict) {
        envelope = {
          ...envelope,
          total_cost_usd: envelope.total_cost_usd + second.envelope.total_cost_usd,
          num_turns: envelope.num_turns + second.envelope.num_turns,
          structured_output: mergeReviewResults(envelope.structured_output, second.envelope.structured_output),
        };
      }
    }
    const usedExtraArgs = run.extraArgs;
    run.extraArgs = '';

    if (envelope.is_error || !envelope.structured_output) {
      const msg = `会话异常：${envelope.result ?? '无结构化返回'}`;
      // 瞬时故障（529 过载、网关、连接抖动）：等几分钟自动重跑一次，不让工单干等人说「继续」；
      // 每个阶段每个 runner 生命周期只自动重试一次，再失败才转人工（确定性错误不该变成重试循环）
      if (envelope.is_error && isTransientApiError(envelope.result ?? '') && !run.retriedTransient.has(stage)) {
        run.retriedTransient.add(stage);
        const minutes = Math.round(run.transientRetryDelayMs / 60_000);
        appendEvent({ ticket, type: 'error', stage, summary: `${msg.slice(0, 200)}｜疑似瞬时故障，${minutes} 分钟后自动重试一次` });
        await port.notify(
          ticket,
          audienceOf(profile) === 'business'
            ? errorLine(stage, msg, ticket, minutes)
            : `${msg}\n疑似 API 瞬时故障，${minutes} 分钟后自动从 ${stage} 阶段重跑一次（不用说「继续」）；再失败才转人工。`,
        );
        await new Promise((r) => setTimeout(r, run.transientRetryDelayMs));
        run.extraArgs = usedExtraArgs; // 带着同样的参数（fix=/feedback=）重跑
        continue;
      }
      appendEvent({ ticket, type: 'error', stage, summary: msg.slice(0, 300) });
      // 挂起消息教人怎么恢复，异常消息也必须教——否则人只看到一句 API Error，不知道下一步说什么
      await port.notify(
        ticket,
        audienceOf(profile) === 'business'
          ? errorLine(stage, msg, ticket, null)
          : `${msg}\n本阶段未产生结果（通常是瞬时故障）。在群里说「继续 ${ticket}」即可从 ${stage} 阶段重跑`,
      );
      return;
    }
    const res = envelope.structured_output;
    const schemaErrors = res.stage === 'ci' ? [] : validateResult(res);
    if (schemaErrors.length) {
      const msg = `回程校验失败：${schemaErrors.join('; ')}`;
      appendEvent({ ticket, type: 'error', stage, summary: msg.slice(0, 300) });
      await port.notify(ticket, msg);
      return;
    }

    const action = route(run.state, res);
    run.state = applyResult(run.state, res, action, envelope.total_cost_usd, envelope.num_turns, envelope.session_id, stageModel);
    // 分支名由实现会话自己取，只能事后认；认到就固化，供看板显示与人工 checkout
    if (stage === 'implement' && !run.state.branch) {
      const b = detectTicketBranch(repo, ticket);
      if (b) run.state = { ...run.state, branch: b };
    }
    run.save();
    const axesLine = res.axes
      ? `｜AC ${res.axes.spec.total - res.axes.spec.failed}/${res.axes.spec.total} · 质量 C${res.axes.quality.critical}/I${res.axes.quality.important}/M${res.axes.quality.minor}`
      : '';
    const endLine = `${res.stage} → ${res.status}${res.verdict ? ` / ${res.verdict}` : ''}${axesLine}（$${envelope.total_cost_usd.toFixed(2)}，${envelope.num_turns} 轮）`;
    appendEvent({
      ticket,
      type: 'stage.end',
      stage,
      summary: endLine,
      payload: { costUsd: envelope.total_cost_usd, turns: envelope.num_turns, handoff: res.handoff_path },
    });
    // 事件流永远记研发版（看板/复盘要状态码）；群里按受众：业务口吻带步骤锚 + 结尾「接下来谁做什么」
    await broadcast(port, ticket, audienceOf(profile) === 'business' ? bizEndLine(res, envelope.total_cost_usd, action) : endLine);
    // 阶段判某条历史知识与现状矛盾：当刻标「待复核」停注入，累计进状态，闭环时一张卡定夺（run/compound.ts）
    if (res.stale_hints?.length) {
      const flagged = await flagStaleHints(ticket, stage, res.stale_hints, port);
      if (flagged.length) {
        run.state = { ...run.state, staleHints: mergeStaleHints(run.state.staleHints, flagged) };
        run.save();
      }
    }

    // 评审通过但既往 BLOCK 未经修复轮：单独在群里喊一声，不能只藏在放行卡的 concerns 里
    // （未配 CI 时根本没有放行卡，这条就是唯一的警示通道）
    if (stage === 'review' && res.verdict && res.verdict !== 'BLOCK') {
      const stale = unconsumedReviewBlocks(run.state.runs);
      if (stale.length) {
        await port.notify(
          ticket,
          audienceOf(profile) === 'business'
            ? staleBlockWarning()
            : `⚠ 本轮 review 通过，但第 ${stale.join('、')} 轮 BLOCK 的阻断项之后未跑过修复轮——通过可能是漏检。放行前请对照 30-review-r${stale[stale.length - 1]}.md 核实阻断项确已消失`,
        );
      }
    }

    // 验收定稿轮（带 verdict）：AC 结果表原文回飞书——业务方要看到逐条结果与证据，不是一句 PASS
    if (stage === 'acceptance' && res.verdict) {
      const rep = extractAcReport(repo, ticket);
      if (rep) {
        if (port.sendReport) await port.sendReport(ticket, `验收结果 ${res.verdict}`, rep);
        else await port.notify(ticket, `验收结果（${res.verdict}）：\n${rep.slice(0, 600)}`);
      }
    }

    if ((await dispatchAction(run, action, res, stage, profile)) === 'return') return;
  }
}

/** 供指令通道使用：给工单排一个回退（下一个安全点生效） */
export function scheduleRewind(repo: string, ticket: string, to: Stage, reason: string, feedbackPath?: string): TicketState {
  const state = loadTicket(repo, ticket, to);
  const next: TicketState = { ...state, pendingRewind: { to, reason, feedbackPath }, haltedReason: undefined };
  saveTicket(next);
  return next;
}
