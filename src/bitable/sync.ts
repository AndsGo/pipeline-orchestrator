import fs from 'node:fs';
import path from 'node:path';
import { onEvent, readEvents, type PipelineEvent } from '../events.js';
import { activeTermsOnly, filterTermsByProject, matchTerms, readTermsFile, renderTermsBrief, writeGlossaryFile } from '../glossary.js';
import { recordHits } from '../hits.js';
import { activeOnly, filterByProject, keywords, readKnowledgeFile, scoreEntry, selectHints, writeHints } from '../knowledge.js';
import { dataDir } from '../paths.js';
import { loadProjects } from '../projects.js';
import { readSnapshot } from '../ticket.js';
import { BitableBoard } from './client.js';
import { nodeRow, ticketRow, type ProjectCfg } from './project.js';

/**
 * 旁路投影器：事件 → 多维表格。
 * 三条铁律：① 绝不阻塞流水线（全异步、异常吞掉）；② 失败进 outbox 可重放；③ 表格只读，不回写流程状态。
 */

export function projectCfgFromEnv(env: NodeJS.ProcessEnv = process.env): ProjectCfg {
  const repoToProject: Record<string, string> = {};
  // 旧配置来源（GITLAB_REPO_MAP，{gitlab项目: 本地路径}）在先——
  try {
    const map = JSON.parse(env.GITLAB_REPO_MAP ?? '{}') as Record<string, string>;
    for (const [proj, local] of Object.entries(map)) repoToProject[local.replace(/\\/g, '/')] = proj;
  } catch {
    /* 没配就没有工件链接 */
  }
  // ——PIPELINE_PROJECTS 的 gitlab 字段在后覆盖：映射收敛为一处（2026-08-26），
  // 新项目只配 PIPELINE_PROJECTS 即可，GITLAB_REPO_MAP 仅为存量兼容保留
  for (const p of loadProjects(env)) if (p.gitlab) repoToProject[p.repo] = p.gitlab;
  return { gitlabUrl: env.GITLAB_URL, repoToProject, defaultBranch: env.GITLAB_DEFAULT_BRANCH || 'master' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BitableSync {
  private queue: Promise<void> = Promise.resolve();
  private cfg = projectCfgFromEnv();

  constructor(
    private board: BitableBoard,
    private isActive: (ticket: string) => boolean,
    private log: (m: string) => void = () => {},
  ) {}

  /** 把一个事件排进投影队列（同步返回，绝不让调用方等待网络） */
  enqueue(ev: PipelineEvent): void {
    this.queue = this.queue.then(() => this.project(ev).catch(() => {}));
  }

  private async project(ev: PipelineEvent): Promise<void> {
    const state = readSnapshot(ev.ticket);
    if (!state) return; // 快照还没落盘（如建单瞬间），下一个事件会补上
    const events = readEvents(ev.ticket);
    const roundOf = (stage: string) => events.filter((e) => e.type === 'stage.end' && e.stage === stage).length;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const recordId = await this.board.upsertTicket(
          ev.ticket,
          ticketRow(state, events, this.cfg, this.isActive(ev.ticket)),
        );
        const node = nodeRow(ev, state, this.cfg, roundOf);
        if (node) await this.board.appendNode(node.key, node.fields, recordId || undefined);
        return;
      } catch (e) {
        if (attempt === 3) {
          this.log(`看板投影失败（已存 outbox 待重放）：${(e as Error).message}`);
          this.toOutbox(ev, (e as Error).message);
          return;
        }
        await sleep(attempt * 800);
      }
    }
  }

  private toOutbox(ev: PipelineEvent, err: string): void {
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.appendFileSync(path.join(dataDir(), 'bitable-outbox.jsonl'), JSON.stringify({ ev, err, at: new Date().toISOString() }) + '\n', 'utf-8');
    } catch {
      /* outbox 也写不了就只剩日志 */
    }
  }
}

/**
 * 装上投影器。未配置 BITABLE_* 时静默跳过——看板是可选能力，不装也不影响流水线。
 * 返回 true 表示已启用。
 */
export function initBitableSync(isActive: (ticket: string) => boolean, log?: (m: string) => void): boolean {
  const board = BitableBoard.fromEnv();
  if (!board) return false;
  const sync = new BitableSync(board, isActive, log);
  onEvent((ev) => sync.enqueue(ev));
  return true;
}

/** 开工前预取知识提示；未配知识表或拉取失败时静默跳过（提示是加分项，不是前提） */
export async function prefetchKnowledgeHints(
  repo: string,
  ticket: string,
  requirement: string,
  project?: string,
): Promise<number> {
  const board = BitableBoard.fromEnv();
  if (!board || process.env.PIPELINE_HINTS_OFF) return 0; // 对照模式：跑一段不注入的时期，指标才有比较基准
  try {
    const all = await board.listKnowledge();
    const picked = selectHints(activeOnly(all), requirement, 12, project);
    writeHints(repo, ticket, picked);
    recordHits(`ticket:${ticket}`, 'knowledge', picked.map((e) => e.title));
    return picked.length;
  } catch {
    return 0;
  }
}

/**
 * 取一段可直接塞进提示词的知识摘要（不落文件）。
 * 给没有工单目录的场景用：单次执行 /run、以后的 MR 评审等。
 * 命中不到相关条目就返回空串——简单问题不该被无关经验噪音干扰。
 */
export async function fetchKnowledgeBrief(query: string, project?: string, limit = 6): Promise<string> {
  const board = BitableBoard.fromEnv();
  if (!board || process.env.PIPELINE_HINTS_OFF) return '';
  try {
    const all = await board.listKnowledge();
    const words = keywords(query);
    const hits = filterByProject(activeOnly(all), project)
      .map((e) => ({ e, s: scoreEntry(e, words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.e);
    if (!hits.length) return '';
    recordHits('run', 'knowledge', hits.map((e) => e.title));
    return [
      '（以下是本项目历史沉淀的相关经验，供参考，不是本次任务的要求）',
      ...hits.map((e) => `- **${e.title}**：${e.practice}`),
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

/** compound 后：知识条目投影 + 交付文档链接回填。条目打上项目烙印，跨项目复用靠"适用范围" */
export async function publishKnowledge(
  repo: string,
  ticket: string,
  project?: string,
): Promise<{ count: number; missingScope: number; created: string[]; updated: string[]; error?: string }> {
  const board = BitableBoard.fromEnv();
  if (!board) return { count: 0, missingScope: 0, created: [], updated: [] };
  const { entries, error } = readKnowledgeFile(repo, ticket);
  // 缺 scope 会被 upsertKnowledge 静默补成"本项目"——通用经验从此困死在一个仓库。补默认值可以，静默不行。
  const missingScope = entries.filter((e) => !e.scope).length;
  let count = 0;
  const created: string[] = [];
  const updated: string[] = [];
  for (const e of entries) {
    try {
      const r = await board.upsertKnowledge({ ...e, project: e.project ?? project });
      count++;
      if (r === 'created') created.push(e.title);
      else if (r === 'updated') updated.push(e.title);
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return { count, missingScope, created, updated, error };
}

/** 开工前预取项目术语表 → 06-glossary.md（全量项目子集，术语表小不做相关性筛选） */
export async function prefetchGlossary(repo: string, ticket: string, project?: string): Promise<number> {
  const board = BitableBoard.fromEnv();
  if (!board) return 0;
  try {
    const terms = filterTermsByProject(activeTermsOnly(await board.listGlossary()), project);
    writeGlossaryFile(repo, ticket, terms);
    return terms.length;
  } catch {
    return 0;
  }
}

/** /run 注入用：只带命中查询文本的词条（规范词或禁用同义词出现即命中） */
export async function fetchGlossaryBrief(query: string, project?: string): Promise<string> {
  const board = BitableBoard.fromEnv();
  if (!board || process.env.PIPELINE_HINTS_OFF) return '';
  try {
    const hits = matchTerms(query, filterTermsByProject(activeTermsOnly(await board.listGlossary()), project));
    recordHits('run', 'term', hits.map((t) => t.term));
    return renderTermsBrief(hits);
  } catch {
    return '';
  }
}

/** clarify 产出的新术语提议入表（待审）。返回新建词条名，供人审卡生效 */
export async function publishTerms(
  repo: string,
  ticket: string,
  project?: string,
): Promise<{ count: number; created: string[]; error?: string }> {
  const board = BitableBoard.fromEnv();
  if (!board) return { count: 0, created: [] };
  const { terms, error } = readTermsFile(repo, ticket);
  let count = 0;
  const created: string[] = [];
  for (const t of terms) {
    try {
      const r = await board.upsertTerm({ ...t, project: t.project ?? project });
      count++;
      if (r === 'created') created.push(t.term);
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return { count, created, error };
}

export async function activateTerms(names: string[]): Promise<number> {
  const board = BitableBoard.fromEnv();
  if (!board) return 0;
  let ok = 0;
  for (const n of names) {
    try {
      if (await board.setTermStatus(n, '生效')) ok++;
    } catch {
      /* 留在待审 */
    }
  }
  return ok;
}

/** 人审通过后把新条目从「待审」翻到「生效」。返回成功条数（best-effort，单条失败不阻塞） */
export async function activateKnowledge(titles: string[]): Promise<number> {
  const board = BitableBoard.fromEnv();
  if (!board) return 0;
  let ok = 0;
  for (const t of titles) {
    try {
      if (await board.setKnowledgeStatus(t, '生效')) ok++;
    } catch {
      /* 留在待审，可在表里手工翻 */
    }
  }
  return ok;
}

export async function setDeliveryDocLink(ticket: string, url: string, wikiUrl?: string | null): Promise<void> {
  const board = BitableBoard.fromEnv();
  if (!board) return;
  try {
    await board.patchTicket(ticket, { 交付文档: { text: wikiUrl ? '交付文档（已归档）' : '交付文档', link: wikiUrl ?? url } });
  } catch {
    /* 回填失败不影响文档已生成 */
  }
}
