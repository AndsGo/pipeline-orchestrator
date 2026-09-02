import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { gateDetail } from './artifacts.js';
import { appendAnswers, type Answer } from './backfill.js';
import {
  activateKnowledge,
  activateTerms,
  prefetchGlossary,
  prefetchKnowledgeHints,
  publishKnowledge,
  publishTerms,
  setDeliveryDocLink,
} from './bitable/sync.js';
import { FIX_ROUND_CAP, IMPLEMENT_AUTO_CONTINUE_CAP, resolveImplementModel, STAGES, ticketDir } from './config.js';
import { appendEvent } from './events.js';
import { appendFeedback, feedbackRelPath, FEEDBACK_FILE } from './feedback.js';
import {
  decideAutoContinue,
  detectTicketBranch,
  type ImplementProgress,
  readImplementProgress,
  resolveLedgerFile,
} from './implementProgress.js';
import { moveDocToWiki, publishMarkdownDoc } from './feishu/docs.js';
import { readTermsFile } from './glossary.js';
import { DELIVERY_FILE, readKnowledgeFile } from './knowledge.js';
import { jenkinsConfigFromEnv, runJenkinsBuild } from './jenkins.js';
import { FASTLANE_MODEL, runFastlane, runTriage, type Lane } from './lanes.js';
import { applyResult, GATE_SOURCE, mergeReviewResults, route, unconsumedReviewBlocks } from './machine.js';
import { isPaused } from './pause.js';
import { generatePrototype, previewUrl } from './prototype.js';
import { MAP_HINT_FILE, mapFreshness, renderMapHint } from './systemMap.js';
import type { InteractionPort } from './ports.js';
import { ciJobFor, type Project } from './projects.js';
import { runStage } from './runner.js';
import { validateResult } from './schema.js';
import { adoptViaMr, applyClaudeMdSuggestions, readSuggestions, renderSuggestionsDetail } from './suggestions.js';
import { loadTicket, readSnapshot, saveTicket } from './ticket.js';
import type { Envelope, OpenQuestion, Stage, StageResult, TicketState } from './types.js';

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
function watchLedger(repo: string, ticket: string, port: InteractionPort): { stop: () => void } {
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
          void port.notify(ticket, `进度：${text}`);
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
 * 闭环收尾：把 compound 产出的交付文档推成飞书云文档并归档，知识条目投进知识表。
 * 全程 best-effort——沉淀失败不能让一单已经完成的工作显示为失败。
 */
async function deliverAndCompound(
  repo: string,
  ticket: string,
  port: InteractionPort,
  project?: Project,
): Promise<{ createdKnowledge: string[]; updatedKnowledge: string[] }> {
  const kb = await publishKnowledge(repo, ticket, project?.alias);
  const kbResult = { createdKnowledge: kb.created, updatedKnowledge: kb.updated };
  if (kb.count) await port.notify(ticket, `已沉淀 ${kb.count} 条知识条目到知识库（新条目为「待审」状态）`);
  if (kb.missingScope) {
    await port.notify(
      ticket,
      `⚠ ${kb.missingScope} 条知识未标适用范围（scope），已按「本项目」入库——通用经验会被困死在本仓库，请在知识表补标`,
    );
  }
  if (kb.error) await port.notify(ticket, `知识条目格式有误未沉淀：${kb.error}`);

  const md = path.join(ticketDir(repo, ticket), DELIVERY_FILE);
  if (!fs.existsSync(md)) return kbResult;
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OWNER_OPEN_ID, WIKI_SPACE_ID, WIKI_ARCHIVE_NODE } = process.env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return kbResult;
  try {
    const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
    const title = `${ticket} 交付文档`;
    const doc = await publishMarkdownDoc(client, title, fs.readFileSync(md, 'utf-8'), FEISHU_OWNER_OPEN_ID);
    // 归档到**该项目**的档案节点，不同项目不混在一个目录里
    const archiveNode = project?.wikiArchive ?? WIKI_ARCHIVE_NODE;
    const wikiUrl = WIKI_SPACE_ID ? await moveDocToWiki(client, WIKI_SPACE_ID, doc.documentId, archiveNode) : null;
    await setDeliveryDocLink(ticket, doc.url, wikiUrl);
    appendEvent({
      ticket,
      type: 'done',
      summary: `交付文档已生成（${doc.blocks} 块${doc.truncated ? '，过长已截断' : ''}）`,
      payload: { url: wikiUrl ?? doc.url },
    });
    await port.notify(ticket, `交付文档：${wikiUrl ?? doc.url}`);
  } catch (e) {
    await port.notify(ticket, `交付文档生成失败（工件仍在 git 中）：${(e as Error).message.slice(0, 200)}`);
  }
  return kbResult;
}

/**
 * 知识状态门：新条目发布后默认「待审」不参与注入，人审通过才「生效」。
 * 没有人审门的自动写入记忆最终都会变成提示词污染源（业界无幸存者，投毒攻击面真实存在）。
 */
async function reviewKnowledge(
  repo: string,
  ticket: string,
  port: InteractionPort,
  created: string[],
  updated: string[],
): Promise<void> {
  if (updated.length) {
    await port.notify(ticket, `${updated.length} 条既有知识条目内容已更新（保持原状态）：${updated.join('、')}`);
  }
  if (!created.length) return;

  const { entries } = readKnowledgeFile(repo, ticket);
  const detail = created
    .map((t, i) => {
      const e = entries.find((x) => x.title === t);
      return `${i + 1}. **${t}**${e ? `（${e.kind}${e.scope ? ` / ${e.scope}` : ''}）\n   做法：${e.practice.slice(0, 150)}` : ''}`;
    })
    .join('\n');
  appendEvent({ ticket, type: 'gate.asked', stage: 'compound', summary: `知识条目人审：新增 ${created.length} 条待生效` });
  const d = await port.confirmGate(
    ticket,
    '知识条目生效',
    `本单新增 ${created.length} 条知识，当前为「待审」，不会注入后续工单。通过 → 全部标记「生效」；驳回 → 保持待审，可稍后在知识表逐条处理。`,
    [],
    detail,
  );
  appendEvent({
    ticket,
    type: 'gate.answered',
    stage: 'compound',
    summary: `知识条目人审 → ${d.approved ? '生效' : '保持待审'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
  });
  if (!d.approved) {
    await port.notify(ticket, `知识条目保持「待审」${d.note ? `：${d.note}` : ''}——不会注入后续工单，可在知识表逐条改状态`);
    return;
  }
  const ok = await activateKnowledge(created);
  await port.notify(
    ticket,
    ok === created.length ? `${ok} 条知识已生效，开始参与后续工单的提示` : `${ok}/${created.length} 条已生效，其余仍为待审（可在知识表手工处理）`,
  );
}

/**
 * 术语人审：clarify 访谈中提议的新词条（93-terms.json）已以「待审」入术语表，
 * 人审通过才「生效」参与注入——术语是喂给所有后续会话的用词标准，必须过人。
 */
async function reviewTerms(repo: string, ticket: string, port: InteractionPort): Promise<void> {
  const t = await publishTerms(repo, ticket, readSnapshot(ticket)?.project);
  if (t.error) {
    await port.notify(ticket, `93-terms.json 格式有误，术语未入表：${t.error}`);
    return;
  }
  if (!t.created.length) return;

  const { terms } = readTermsFile(repo, ticket);
  const detail = t.created
    .map((n, i) => {
      const x = terms.find((v) => v.term === n);
      return `${i + 1}. **${n}**${x ? `：${x.definition.slice(0, 120)}${x.banned?.length ? `（禁用：${x.banned.join('、')}）` : ''}` : ''}`;
    })
    .join('\n');
  appendEvent({ ticket, type: 'gate.asked', stage: 'compound', summary: `术语人审：新增 ${t.created.length} 条待生效` });
  const d = await port.confirmGate(
    ticket,
    '术语入表',
    `本单访谈中提炼出 ${t.created.length} 条业务术语，当前为「待审」。通过 → 生效，成为后续所有工单的用词标准；驳回 → 保持待审，可在术语表逐条处理。`,
    [],
    detail,
  );
  appendEvent({
    ticket,
    type: 'gate.answered',
    stage: 'compound',
    summary: `术语人审 → ${d.approved ? '生效' : '保持待审'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
  });
  if (!d.approved) {
    await port.notify(ticket, `术语保持「待审」${d.note ? `：${d.note}` : ''}`);
    return;
  }
  const ok = await activateTerms(t.created);
  await port.notify(ticket, ok === t.created.length ? `${ok} 条术语已生效` : `${ok}/${t.created.length} 条术语已生效，其余待审`);
}

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

/**
 * compound 建议人审：CLAUDE.md 建议发确认卡，采纳即自动合入并提交。
 * 建议只躺在 90-retro.md 里时没有消费者——同一条环境限制曾被各阶段独立重复发现 7+ 次。
 */
async function reviewSuggestions(repo: string, ticket: string, port: InteractionPort): Promise<void> {
  const { suggestions, error } = readSuggestions(repo, ticket);
  if (error) {
    await port.notify(ticket, `92-suggestions.json 格式有误，未发起建议人审：${error}`);
    return;
  }
  // 流程建议无法自动执行（目标是 plugin 仓库的 skill），只提醒 + 指路，不做假承诺
  if (suggestions.process.length) {
    await port.notify(
      ticket,
      `本单有 ${suggestions.process.length} 条流程改进建议（需人工改 skill）：\n` +
        suggestions.process.map((p) => `- [${p.skill}] ${p.suggestion}`).join('\n'),
    );
  }
  if (!suggestions.claudeMd.length) return;

  appendEvent({
    ticket,
    type: 'gate.asked',
    stage: 'compound',
    summary: `知识建议人审：CLAUDE.md ${suggestions.claudeMd.length} 条`,
  });
  const d = await port.confirmGate(
    ticket,
    '知识建议采纳',
    `本单沉淀出 ${suggestions.claudeMd.length} 条 CLAUDE.md 建议。通过即自动合入仓库 CLAUDE.md 并提交；驳回请写原因。`,
    [],
    renderSuggestionsDetail(suggestions),
  );
  appendEvent({
    ticket,
    type: 'gate.answered',
    stage: 'compound',
    summary: `知识建议人审 → ${d.approved ? '采纳' : '驳回'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
  });
  if (!d.approved) {
    await port.notify(ticket, `建议已驳回${d.note ? `：${d.note}` : ''}（原文保留在 90-retro.md，不合入）`);
    return;
  }

  // 专用分支 + MR：常识变更必须有一条进主干的路，不能落在恰好检出的分支上
  const r = adoptViaMr(repo, ticket, suggestions.claudeMd);
  if (r.ok) {
    if (!r.applied.length) {
      await port.notify(ticket, 'CLAUDE.md 建议内容均已在主干，无需合入');
      return;
    }
    const via = r.mrUrl
      ? `MR 已创建：${r.mrUrl}（合并后生效）`
      : r.pushedBranch
        ? `分支 ${r.pushedBranch} 已推送（远端不支持自动建 MR，请手动创建）`
        : '已推送到专用分支';
    await port.notify(
      ticket,
      `已把 ${r.applied.length} 条建议提交到专用分支，${via}${r.skipped.length ? `（${r.skipped.length} 条主干已有，跳过）` : ''}`,
    );
    return;
  }
  // 远端路径失败（无远端/网络断/试跑环境）：回退为合入当前工作区分支——留痕比丢失强，但要明示风险
  const local = applyClaudeMdSuggestions(repo, suggestions.claudeMd);
  if (local.applied.length) {
    try {
      execSync('git add CLAUDE.md', { cwd: repo });
      execSync(`git commit -m "chore(${ticket}): 采纳沉淀建议，更新 CLAUDE.md"`, { cwd: repo });
      await port.notify(
        ticket,
        `MR 路径失败（${r.error}），已回退合入当前分支——这些常识要随本分支的 MR 合并才能进主干，请留意`,
      );
    } catch (e) {
      await port.notify(ticket, `CLAUDE.md 已更新但提交失败，请手工提交：${(e as Error).message.slice(0, 200)}`);
    }
  } else {
    await port.notify(ticket, `MR 路径失败（${r.error}），且建议内容当前分支已有，无需合入`);
  }
}

/**
 * 单工单的完整生命周期（分诊 → 快车道/全流水线 → 闭环）。
 * cli.ts 与 daemon.ts 共用；daemon 用 acquire 限制并发 claude 会话数。
 */
export async function runTicket(opts: RunTicketOpts): Promise<void> {
  const { repo, ticket, port, project } = opts;
  ensureIntake(repo, ticket, opts.requirement, opts.intakeContext);
  let state = loadTicket(repo, ticket, opts.startStage ?? 'clarify', project);
  if (project && state.project !== project.alias) {
    state = { ...state, project: project.alias }; // 项目归属随工单固化，后续阶段与投影都读它
    saveTicket(state);
  }
  // 续跑时恢复上次未用掉的阶段参数（暂停/重启不能丢掉修复轮的 findings 指针）
  let extraArgs = state.pendingExtraArgs ?? '';

  // 挂起重试卡每次 runner 生命周期只发一次：确定性失败不该变成无限重试循环（AutoPort 会自动放行）
  let offeredRetry = false;
  // 评审仲裁卡同样只发一次：AutoPort 自动放行时最多追加一轮修复，不能变成 BLOCK→修复的无限循环
  let offeredArbitration = false;

  /** 弹卡点并落地答复。卡在 state.pendingGate 里持久化到答复为止——重启后重发这张卡，而不是跳过它 */
  const askGate = async (g: NonNullable<TicketState['pendingGate']>): Promise<void> => {
    appendEvent({ ticket, type: 'gate.asked', stage: g.stage, summary: `卡点 ${g.gate} 等待人工` });
    const d = await port.confirmGate(ticket, g.gate, g.summary, g.concerns, gateDetail(g.gate, repo, ticket));
    appendEvent({
      ticket,
      type: 'gate.answered',
      stage: g.stage,
      summary: `卡点 ${g.gate} → ${d.approved ? '通过' : '驳回'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
    });
    state = { ...state, pendingGate: undefined };
    if (!d.approved) {
      const back = GATE_SOURCE[g.gate] ?? 'halt';
      const fbPath = appendFeedback(repo, ticket, `${g.gate} 驳回`, d.note ?? '（未填写原因）');
      if (back === 'halt') {
        state = { ...state, haltedReason: `${g.gate} 驳回：${d.note ?? '未填写原因'}` };
      } else {
        // 驳回不是终止，而是带着人的意见重跑产出这份材料的阶段
        state = { ...state, pendingRewind: { to: back, reason: `${g.gate} 驳回`, feedbackPath: fbPath } };
      }
    } else if (d.note?.trim()) {
      appendFeedback(repo, ticket, `${g.gate} 通过备注`, d.note);
    }
    saveTicket(state);
  };

  // implement 分批续做：上一批开工前的进展基线 + 本进程已自动续跑的批次数（判据见 implementProgress.ts）
  let implementBefore: ImplementProgress | undefined;
  let autoContinued = 0;

  const withGate = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = opts.acquire ? await opts.acquire() : null;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };

  // 分诊：仅新工单（无运行记录、无既定通道）
  if (!state.lane && state.runs.length === 0) {
    if (opts.lane) {
      state = { ...state, lane: opts.lane };
      await port.notify(ticket, `通道由参数指定：${state.lane}`);
    } else {
      const t = await withGate(() => runTriage(repo, ticket));
      state = { ...state, lane: t.lane };
      appendEvent({ ticket, type: 'triage', summary: `分诊 ${t.lane}：${t.reason}`, payload: { costUsd: t.costUsd } });
      await port.notify(
        ticket,
        `分诊：${t.lane === 'fast' ? '快车道（单会话直接实现）' : '全流水线'}——${t.reason}（$${t.costUsd.toFixed(2)}）`,
      );
    }
    saveTicket(state);
  }

  // 快车道：单会话实现，ESCALATE 自动降级回全流水线
  if (state.lane === 'fast') {
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
    const { result, costUsd, turns } = await withGate(() => runFastlane(repo, ticket));
    state = {
      ...state,
      runs: [
        ...state.runs,
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
      saveTicket(state);
      return;
    }
    if (result.status === 'ESCALATE') {
      state = { ...state, lane: 'full' };
      await port.notify(ticket, `快车道升级为全流水线：${result.reason ?? result.summary_for_card}`);
    } else {
      state = { ...state, haltedReason: `快车道 BLOCKED：${result.reason ?? result.summary_for_card}` };
    }
    saveTicket(state);
  }

  for (;;) {
    // 指令通道会在会话运行期间直接改盘上的状态（暂停/回退/需求变更），
    // 而本 runner 手里是自己的内存副本——不回读就会在下次 saveTicket 时把人的指令悄悄覆盖掉。
    const disk = readSnapshot(ticket);
    if (disk?.pendingRewind && !state.pendingRewind) state = { ...state, pendingRewind: disk.pendingRewind };

    // 待执行回退（amend/rewind 指令）优先于一切：这是人的意志
    if (state.pendingRewind) {
      const { to, reason, feedbackPath } = state.pendingRewind;
      state = { ...state, cursor: to, pendingRewind: undefined, haltedReason: undefined };
      if (feedbackPath) extraArgs = `feedback=${feedbackPath}`;
      saveTicket(state);
      appendEvent({ ticket, type: 'rewind', stage: to, summary: `回退到 ${to}：${reason}` });
      await port.notify(ticket, `已回退到 ${to} 重跑（${reason}）`);
    }
    if (state.haltedReason) {
      appendEvent({ ticket, type: 'halt', stage: state.cursor, summary: state.haltedReason });
      // 大计划的 implement 装不进一次会话：只要台账显示上一批真有进展、任务还没做完，就自己续下一批，
      // 不必每批都等人在群里说一次「继续」（LS-012 一天里已经手工点了两次，按其分批建议还要再点三次）。
      if (state.cursor === 'implement') {
        const d = decideAutoContinue({
          before: implementBefore,
          now: readImplementProgress(repo, ticket),
          used: autoContinued,
          cap: IMPLEMENT_AUTO_CONTINUE_CAP,
        });
        if (d.ok) {
          autoContinued += 1;
          state = { ...state, haltedReason: undefined };
          saveTicket(state);
          appendEvent({ ticket, type: 'resume', stage: 'implement', summary: `自动续跑：${d.reason}` });
          await port.notify(ticket, `implement 未做完但有进展——${d.reason}。继续下一批，不用管`);
          continue;
        }
        await port.notify(ticket, `未自动续跑：${d.reason}`);
      }
      // review 达轮上限的挂起：默认动作是「追加一轮修复」而不是「重跑 review」。
      // 重跑属于重摇骰子——哪一轮评审恰好漏检，工单就带着未修复的阻断项通过（LS-012：
      // r3/r4 两轮独立确认的 Critical，在人工点重试后的 r5 被漏检并 PASS，一路走完验收）。
      const lastRun = state.runs[state.runs.length - 1];
      if (state.cursor === 'review' && lastRun?.stage === 'review' && lastRun.verdict === 'BLOCK' && !offeredArbitration) {
        offeredArbitration = true;
        const stale = unconsumedReviewBlocks(state.runs);
        appendEvent({ ticket, type: 'gate.asked', stage: 'review', summary: `评审仲裁卡：第 ${stale.join('、')} 轮阻断项未消化` });
        const d = await port.confirmGate(
          ticket,
          'review-arbitration',
          `review 已打回到 ${FIX_ROUND_CAP} 轮上限，且第 ${stale.join('、')} 轮的 BLOCK 阻断项之后没有跑过修复轮。` +
            `直接重跑 review 等于重摇骰子——评审哪轮恰好漏检，工单就会带着未修复的阻断项通过。\n\n` +
            `通过 → 追加一轮 implement 修复（自动带上最新评审报告，备注会作为约束带入）\n` +
            `驳回 → 保持挂起；确要重跑 review 的话在群里说「继续 ${ticket}」`,
          [],
        );
        appendEvent({
          ticket,
          type: 'gate.answered',
          stage: 'review',
          summary: `评审仲裁 → ${d.approved ? '追加修复轮' : '保持挂起'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
        });
        if (d.approved) {
          if (d.note?.trim()) appendFeedback(repo, ticket, '评审仲裁：追加修复轮说明', d.note);
          // fix= 指针不在这里拼：循环顶部的 pendingReverify 重建逻辑会生成（与挂起重启后的修复轮同一条路）
          state = {
            ...state,
            cursor: 'implement',
            pendingReverify: 'review',
            reviewFixRounds: state.reviewFixRounds + 1,
            haltedReason: undefined,
          };
          saveTicket(state);
          appendEvent({ ticket, type: 'resume', stage: 'implement', summary: '仲裁追加修复轮' });
          await port.notify(ticket, '追加修复轮：打回 implement 修复未消化的阻断项…');
          continue;
        }
        if (d.note?.trim()) appendFeedback(repo, ticket, '评审仲裁备注', d.note);
        await port.notify(ticket, `已挂起：${state.haltedReason}。处理后在群里说「继续 ${ticket}」（会重跑 review）`);
        return;
      }
      // 错误翻译层：不把人丢给一句技术挂起原因，直接给「重试」按钮（本 runner 只发一次，防确定性失败空转）
      if (!offeredRetry) {
        offeredRetry = true;
        appendEvent({ ticket, type: 'gate.asked', stage: state.cursor, summary: '挂起处理卡：是否立即重试' });
        const d = await port.confirmGate(
          ticket,
          '挂起处理',
          `工单在 ${state.cursor} 阶段挂起：${state.haltedReason.slice(0, 300)}\n\n通过 → 让 AI 立即重试该阶段（备注会作为约束带入）；驳回 → 保持挂起，处理好后在群里说「继续 ${ticket}」`,
          [],
        );
        appendEvent({
          ticket,
          type: 'gate.answered',
          stage: state.cursor,
          summary: `挂起处理 → ${d.approved ? '重试' : '保持挂起'}${d.note ? `（${d.note.slice(0, 80)}）` : ''}`,
        });
        if (d.approved) {
          if (d.note?.trim()) {
            const fb = appendFeedback(repo, ticket, '挂起重试说明', d.note);
            extraArgs = `feedback=${fb}`;
          }
          state = { ...state, haltedReason: undefined };
          saveTicket(state);
          await port.notify(ticket, `重试 ${state.cursor} 阶段…`);
          continue;
        }
        if (d.note?.trim()) appendFeedback(repo, ticket, '挂起备注', d.note);
      }
      await port.notify(ticket, `已挂起：${state.haltedReason}。处理后续跑，或在群里说「继续 ${ticket}」`);
      return;
    }
    if (isPaused(ticket)) {
      appendEvent({ ticket, type: 'pause', stage: state.cursor, summary: `在 ${state.cursor} 前暂停` });
      await port.notify(ticket, `已在安全点暂停（游标 ${state.cursor}）。恢复：群里说"继续 ${ticket}"或重跑 start-ticket`);
      return;
    }
    // 重启前弹出、没等到答复的卡点：原样重发。游标早已推到下一阶段，不拦在这里就等于人没审批直接开工
    if (state.pendingGate) {
      await port.notify(ticket, `重启前的 ${state.pendingGate.gate} 卡未得到答复，原样重发（${state.pendingGate.stage} 阶段产物未变，不重跑）`);
      await askGate(state.pendingGate);
      continue;
    }

    // 首次 implement 前记录分支切出点，review 阶段以此为 diff 基点
    if (state.cursor === 'implement' && !state.baseSha) {
      state = { ...state, baseSha: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim() };
      saveTicket(state);
    }
    if (state.cursor === 'review' && !extraArgs && state.baseSha) extraArgs = `base=${state.baseSha}`;
    // 修复轮的 fix= 参数在挂起/重启后已被消费——从 pendingReverify 重建，否则重进的 implement 不知道自己在修复模式
    if (state.cursor === 'implement' && !extraArgs && state.pendingReverify) {
      const src = state.pendingReverify === 'acceptance' ? `docs/pipeline/${ticket}/40-acceptance.md` : latestReviewPath(repo, ticket);
      const fb = path.join(ticketDir(repo, ticket), FEEDBACK_FILE);
      if (src) extraArgs = `fix=${src}${fs.existsSync(fb) ? ` feedback=${feedbackRelPath(ticket)}` : ''}`;
    }

    const stage = state.cursor;
    // 对照实验臂在首次进入 implement 时冻结进工单，之后所有分批与修复轮都用同一个模型
    if (stage === 'implement' && !state.implementModel) {
      const arm = resolveImplementModel();
      state = { ...state, implementModel: arm.model };
      saveTicket(state);
      if (arm.note) await port.notify(ticket, arm.note);
    }
    const stageModel = stage === 'ci' ? undefined : stage === 'implement' ? state.implementModel : STAGES[stage].model;
    // 开工前预取历史知识提示（ci 是编排器原生阶段，没有会话读它）。曾经只有澄清/计划读——
    // 但知识多由 review/acceptance 产出，不回流给产出它的阶段，同类问题就会反复出现；
    // compound 也要读：标题是知识去重的键，看得到既有条目才不会换个说法重复记。
    if (stage !== 'ci') {
      if (process.env.PIPELINE_HINTS_OFF) {
        // 对照期必须显式可见——静默关闭注入会让指标比较变成无人知晓的暗箱
        if (stage === 'clarify') await port.notify(ticket, '⚠ 对照模式（PIPELINE_HINTS_OFF）：本单不注入历史知识与术语');
      } else {
        const intakeFile = path.join(ticketDir(repo, ticket), '00-intake.md');
        const requirement = fs.existsSync(intakeFile) ? fs.readFileSync(intakeFile, 'utf-8') : '';
        const n = await prefetchKnowledgeHints(repo, ticket, requirement, project?.alias);
        if (n) await port.notify(ticket, `已预取 ${n} 条历史知识提示供本阶段参考`);
        // 能力地图的新鲜度：地图可以旧，但不许假装新——落后多少提交、哪些能力已变动，
        // 都写进注入头交给会话自己判断，而不是让它默认相信一份不知多旧的地图
        const fresh = mapFreshness(repo);
        if (fresh.exists) {
          fs.writeFileSync(path.join(ticketDir(repo, ticket), MAP_HINT_FILE), renderMapHint(fresh), 'utf-8');
          if (stage === 'clarify') await port.notify(ticket, `能力地图：${fresh.headline}`);
        }
        const g = await prefetchGlossary(repo, ticket, project?.alias);
        if (g && stage === 'clarify') await port.notify(ticket, `已注入项目术语表 ${g} 条（PRD 用语以此为准）`);
      }
    }
    // CLAUDE.md 是各阶段的隐式输入（frontmatter inputs 里看不到）——记录其内容哈希，行为差异才可审计（外部评审建议）
    const claudeMdFile = path.join(repo, 'CLAUDE.md');
    const claudeMdSha = fs.existsSync(claudeMdFile)
      ? createHash('sha1').update(fs.readFileSync(claudeMdFile)).digest('hex').slice(0, 12)
      : 'absent';
    appendEvent({
      ticket,
      type: 'stage.start',
      stage,
      summary: `阶段 ${stage} 开始${extraArgs ? `（${extraArgs}）` : ''}`,
      payload: { claudeMdSha, ...(stageModel ? { model: stageModel } : {}) },
    });
    await port.notify(ticket, `运行阶段 ${stage}${extraArgs ? `（${extraArgs}）` : ''}…`);

    if (state.pendingExtraArgs) {
      state = { ...state, pendingExtraArgs: undefined }; // 已取用，避免下一阶段重复带上
      saveTicket(state);
    }
    // 开工前的进展基线：下一轮挂起时用它判断「上一批到底推进了没有」
    if (stage === 'implement') implementBefore = readImplementProgress(repo, ticket);
    const ledgerWatch = stage === 'implement' ? watchLedger(repo, ticket, port) : null;
    let envelope: Envelope;
    try {
      envelope = await withGate(() =>
        stage === 'ci'
          ? runCiStage(repo, ticket, port, project)
          : runStage(repo, ticket, stage, extraArgs, stageModel).then((r) => r.envelope),
      );
    } finally {
      ledgerWatch?.stop();
    }

    // 双评审取严
    if (stage === 'review' && process.env.PIPELINE_DOUBLE_REVIEW === '1' && envelope.structured_output?.verdict) {
      await port.notify(ticket, '双评审模式：启动第二轮独立评审…');
      const second = await withGate(() => runStage(repo, ticket, 'review', extraArgs));
      if (second.envelope.structured_output?.verdict) {
        envelope = {
          ...envelope,
          total_cost_usd: envelope.total_cost_usd + second.envelope.total_cost_usd,
          num_turns: envelope.num_turns + second.envelope.num_turns,
          structured_output: mergeReviewResults(envelope.structured_output, second.envelope.structured_output),
        };
      }
    }
    extraArgs = '';

    if (envelope.is_error || !envelope.structured_output) {
      const msg = `会话异常：${envelope.result ?? '无结构化返回'}`;
      appendEvent({ ticket, type: 'error', stage, summary: msg.slice(0, 300) });
      // 挂起消息教人怎么恢复，异常消息也必须教——否则人只看到一句 API Error，不知道下一步说什么
      await port.notify(ticket, `${msg}\n本阶段未产生结果（通常是瞬时故障）。在群里说「继续 ${ticket}」即可从 ${stage} 阶段重跑`);
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

    const action = route(state, res);
    state = applyResult(state, res, action, envelope.total_cost_usd, envelope.num_turns, envelope.session_id, stageModel);
    // 分支名由实现会话自己取，只能事后认；认到就固化，供看板显示与人工 checkout
    if (stage === 'implement' && !state.branch) {
      const b = detectTicketBranch(repo, ticket);
      if (b) state = { ...state, branch: b };
    }
    saveTicket(state);
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
    await port.notify(ticket, endLine);

    // 评审通过但既往 BLOCK 未经修复轮：单独在群里喊一声，不能只藏在放行卡的 concerns 里
    // （未配 CI 时根本没有放行卡，这条就是唯一的警示通道）
    if (stage === 'review' && res.verdict && res.verdict !== 'BLOCK') {
      const stale = unconsumedReviewBlocks(state.runs);
      if (stale.length) {
        await port.notify(
          ticket,
          `⚠ 本轮 review 通过，但第 ${stale.join('、')} 轮 BLOCK 的阻断项之后未跑过修复轮——通过可能是漏检。放行前请对照 30-review-r${stale[stale.length - 1]}.md 核实阻断项确已消失`,
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

    switch (action.kind) {
      case 'done': {
        // compound 的结论此前被通知逻辑丢弃（只有卡点阶段消费 summary_for_card），人根本不知道有教训沉淀
        if (res.summary_for_card) await port.notify(ticket, `沉淀结论：${res.summary_for_card}`);
        await reviewSuggestions(repo, ticket, port);
        const kb = await deliverAndCompound(repo, ticket, port, project);
        await reviewKnowledge(repo, ticket, port, kb.createdKnowledge, kb.updatedKnowledge);
        await reviewTerms(repo, ticket, port);
        const total = state.runs.reduce((s, r) => s + r.costUsd, 0);
        appendEvent({ ticket, type: 'done', summary: `闭环：${state.runs.length} 次会话，$${total.toFixed(2)}` });
        await port.notify(ticket, `流水线闭环。共 ${state.runs.length} 次会话，合计 $${total.toFixed(2)}`);
        return;
      }
      case 'halt':
        state = { ...state, haltedReason: action.reason };
        saveTicket(state);
        continue;
      case 'gate': {
        let gateSummary = action.summary;
        // 结果预览（grill-me 定稿 2026-09-01）：prd-confirm 是决策质量最差的一环——业务人员面对
        // 大段文字只能盲点通过。确认卡弹出前用 sonnet 生成一页可看的原型（UI 可点/数据样例表/流程图），
        // 失败不阻塞卡点；驳回回 clarify 后下次进卡点自动重生成（原型永远是定稿 PRD 的投影）
        if (action.gate === 'prd-confirm') {
          await port.notify(ticket, '正在生成结果预览（1~3 分钟），随 PRD 确认卡一起发出…');
          const p = await generatePrototype(repo, ticket);
          if (p.ok) {
            const url = previewUrl(ticket);
            gateSummary = `${
              url
                ? `📱 **结果预览**：${url}\n（示意非承诺，页内附验收标准清单）`
                : `📱 结果预览已生成：docs/pipeline/${ticket}/prototype/index.html（配置 PREVIEW_BASE_URL 后卡片将带可点链接）`
            }\n\n${gateSummary}`;
            // 成本入账：记为 clarify 的附属会话（extraArgs 标注来源），看板成本才不撒谎
            state = {
              ...state,
              runs: [
                ...state.runs,
                { stage: 'clarify', extraArgs: 'prototype', startedAt: new Date().toISOString(), costUsd: p.costUsd, turns: p.turns, status: 'DONE', sessionId: 'prototype' },
              ],
            };
            saveTicket(state);
          } else {
            await port.notify(ticket, `结果预览生成失败（不影响确认，PRD 材料齐全）：${p.note ?? '未知原因'}`);
          }
          // 可发现性（grill-me 问题 5 的缺口）：业务人员不知道卡片按钮之外可以直接说话
          gateSummary += '\n\n_按钮之外有任何意见，直接在群里说即可：小的记进需求，大的会回澄清重做。_';
        }
        // 先落盘再弹卡：卡随进程内存消失，盘上的这条记录是重启后重发它的唯一依据
        state = { ...state, pendingGate: { gate: action.gate, summary: gateSummary, concerns: action.concerns, stage } };
        saveTicket(state);
        await askGate(state.pendingGate!);
        continue;
      }
      case 'ask': {
        appendEvent({
          ticket,
          type: 'question.asked',
          stage,
          summary: `${action.questions.length} 个待确认问题：${action.questions.map((q) => q.id).join(', ')}`,
        });
        let answers = await port.askQuestions(ticket, action.questions);
        if (stage === 'acceptance') answers = await ensureRejectionEvidence(port, ticket, action.questions, answers);
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
          extraArgs = `feedback=${fb}`;
        }
        continue;
      }
      case 'fix': {
        // 人在群里补充的说明（feedback.md）对修复轮同样有约束力：验收只答"不通过"时，现象往往只写在这里
        const fb = path.join(ticketDir(repo, ticket), FEEDBACK_FILE);
        extraArgs = `fix=${action.findingsPath}${fs.existsSync(fb) ? ` feedback=${feedbackRelPath(ticket)}` : ''}`;
        state = { ...state, pendingExtraArgs: extraArgs };
        saveTicket(state);
        continue;
      }
      case 'run':
        continue;
    }
  }
}

/** 供指令通道使用：给工单排一个回退（下一个安全点生效） */
export function scheduleRewind(repo: string, ticket: string, to: Stage, reason: string, feedbackPath?: string): TicketState {
  const state = loadTicket(repo, ticket, to);
  const next: TicketState = { ...state, pendingRewind: { to, reason, feedbackPath }, haltedReason: undefined };
  saveTicket(next);
  return next;
}
