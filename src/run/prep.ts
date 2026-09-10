import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prefetchGlossary, prefetchKnowledgeHints } from '../bitable/sync.js';
import { resolveImplementModel, STAGES, ticketDir } from '../config.js';
import { appendEvent, typicalStageMinutes } from '../events.js';
import { readImplementProgress } from '../implementProgress.js';
import { engineFor } from '../engine/index.js';
import { type PipelineProfile, STAGE_PROFILE_FILE, stageBrief } from '../profile.js';
import { MAP_HINT_FILE, mapFreshness, renderMapHint } from '../systemMap.js';
import { broadcast } from '../ports.js';
import type { Stage } from '../types.js';
import { audienceOf, startLine } from '../voice.js';
import type { TicketRun } from './context.js';

/** 项目流程约定节选：每阶段开工前抄进工单目录供会话先读；没有约定或该阶段无节 → 删掉旧文件，不留过期内容 */
function writeStageProfile(repo: string, ticket: string, stage: Stage, profile: PipelineProfile | null): void {
  const f = path.join(ticketDir(repo, ticket), STAGE_PROFILE_FILE);
  const brief = profile && stage !== 'ci' ? stageBrief(profile, stage) : null;
  if (brief) fs.writeFileSync(f, brief, 'utf-8');
  else fs.rmSync(f, { force: true });
}

/**
 * 阶段开工前的准备：项目约定节选、模型冻结、知识/术语/能力地图注入、stage.start 事件与群通知、
 * 消费掉持久化的 pendingExtraArgs、记 implement 进展基线。返回本阶段要用的模型（ci 无）。
 */
export async function prepareStage(run: TicketRun, stage: Stage, profile: PipelineProfile | null): Promise<string | undefined> {
  const { repo, ticket, port, project } = run;
  writeStageProfile(repo, ticket, stage, profile);
  // 对照实验臂在首次进入 implement 时冻结进工单，之后所有分批与修复轮都用同一个模型
  if (stage === 'implement' && !run.state.implementModel) {
    const arm = resolveImplementModel();
    run.state = { ...run.state, implementModel: arm.model };
    run.save();
    if (arm.note) await port.notify(ticket, arm.note);
  }
  const stageModel = stage === 'ci' ? undefined : stage === 'implement' ? run.state.implementModel : STAGES[stage].model;
  // 事件里的 model 标签要如实：非 claude 引擎跑时，stageModel 只是 claude 侧配置，实际用的是 codex 的默认模型。
  // 只改事件展示，不动传给引擎的 stageModel（2026-09-04 实测：Codex 评审事件写着 opus，看板与对照实验被误导）
  const engineName = stage === 'ci' ? 'claude' : engineFor(repo, stage).name;
  const modelLabel = engineName === 'claude' ? stageModel : `codex:${process.env.PIPELINE_CODEX_MODEL || '默认'}`;
  // 开工前预取历史知识提示（ci 是编排器原生阶段，没有会话读它）。曾经只有澄清/计划读——
  // 但知识多由 review/acceptance 产出，不回流给产出它的阶段，同类问题就会反复出现；
  // compound 也要读：标题是知识去重的键，看得到既有条目才不会换个说法重复记。
  // 业务口吻下预取/地图/术语这些内部机制不播——对业务方是噪音
  const internal = audienceOf(profile) === 'business' ? async (): Promise<void> => {} : (m: string) => port.notify(ticket, m);
  if (stage !== 'ci') {
    if (process.env.PIPELINE_HINTS_OFF) {
      // 对照期必须显式可见——静默关闭注入会让指标比较变成无人知晓的暗箱
      if (stage === 'clarify') await port.notify(ticket, '⚠ 对照模式（PIPELINE_HINTS_OFF）：本单不注入历史知识与术语');
    } else {
      const intakeFile = path.join(ticketDir(repo, ticket), '00-intake.md');
      const requirement = fs.existsSync(intakeFile) ? fs.readFileSync(intakeFile, 'utf-8') : '';
      const n = await prefetchKnowledgeHints(repo, ticket, requirement, project?.alias);
      if (n) await internal(`已预取 ${n} 条历史知识提示供本阶段参考`);
      // 能力地图的新鲜度：地图可以旧，但不许假装新——落后多少提交、哪些能力已变动，
      // 都写进注入头交给会话自己判断，而不是让它默认相信一份不知多旧的地图
      const fresh = mapFreshness(repo);
      if (fresh.exists) {
        fs.writeFileSync(path.join(ticketDir(repo, ticket), MAP_HINT_FILE), renderMapHint(fresh), 'utf-8');
        if (stage === 'clarify') await internal(`能力地图：${fresh.headline}`);
      }
      const g = await prefetchGlossary(repo, ticket, project?.alias);
      if (g && stage === 'clarify') await internal(`已注入项目术语表 ${g} 条（PRD 用语以此为准）`);
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
    summary: `阶段 ${stage} 开始${run.extraArgs ? `（${run.extraArgs}）` : ''}`,
    payload: { claudeMdSha, ...(modelLabel ? { model: modelLabel } : {}) },
  });
  await broadcast(
    port,
    ticket,
    audienceOf(profile) === 'business'
      ? startLine(stage, run.extraArgs, typicalStageMinutes(stage))
      : `运行阶段 ${stage}${run.extraArgs ? `（${run.extraArgs}）` : ''}…`,
  );

  if (run.state.pendingExtraArgs) {
    run.state = { ...run.state, pendingExtraArgs: undefined }; // 已取用，避免下一阶段重复带上
    run.save();
  }
  // 开工前的进展基线：下一轮挂起时用它判断「上一批到底推进了没有」
  if (stage === 'implement') run.implementBefore = readImplementProgress(repo, ticket);
  return stageModel;
}
