import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { activateKnowledge, activateTerms, publishKnowledge, publishTerms, setDeliveryDocLink } from '../bitable/sync.js';
import { ticketDir } from '../config.js';
import { appendEvent } from '../events.js';
import { moveDocToWiki, publishMarkdownDoc } from '../feishu/docs.js';
import { readTermsFile } from '../glossary.js';
import { DELIVERY_FILE, readKnowledgeFile } from '../knowledge.js';
import type { InteractionPort } from '../ports.js';
import type { Project } from '../projects.js';
import { adoptViaMr, applyClaudeMdSuggestions, readSuggestions, renderSuggestionsDetail } from '../suggestions.js';
import { readSnapshot } from '../ticket.js';

/**
 * 闭环收尾：把 compound 产出的交付文档推成飞书云文档并归档，知识条目投进知识表。
 * 全程 best-effort——沉淀失败不能让一单已经完成的工作显示为失败。
 */
export async function deliverAndCompound(
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
export async function reviewKnowledge(
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
export async function reviewTerms(repo: string, ticket: string, port: InteractionPort): Promise<void> {
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
 * compound 建议人审：CLAUDE.md 建议发确认卡，采纳即自动合入并提交。
 * 建议只躺在 90-retro.md 里时没有消费者——同一条环境限制曾被各阶段独立重复发现 7+ 次。
 */
export async function reviewSuggestions(repo: string, ticket: string, port: InteractionPort): Promise<void> {
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
