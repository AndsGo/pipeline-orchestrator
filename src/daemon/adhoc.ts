import path from 'node:path';
import { writeAdhocRecord } from '../adhocLog.js';
import { PLUGIN_DIR } from '../config.js';
import {
  composeFollowupPrompt,
  composeRequirementDraftPrompt,
  describeLastRun,
  type LastRun,
  readLastRunFor,
  rememberRunCard,
  runByCard,
  saveLastRunFor,
  withRound,
} from '../followup.js';
import { type ChatRef, chatIdOf, rootIdOf } from '../ports.js';
import { describeProjects, resolveProject, type Project } from '../projects.js';
import { engineFor } from '../engine/index.js';
import { expiredSessionBrief, getThread, rememberThreadRun, sessionFresh } from '../threads.js';
import type { DaemonContext } from './context.js';

/**
 * 单次执行的公共执行体（/run 与续聊共用）：跑会话 → 落盘留痕 → 发结果 → 更新续聊指针。
 * commandText 是这一轮的用户原话（留痕与记账用），corePrompt 是发给模型的正文（可能带知识摘要或续聊上下文）。
 * 返回是否已向群里交付结果：resume 尝试在会话启动阶段就失败时返回 false 且不打扰群（由调用方降级重试）。
 */
export async function execAdhoc(
  ctx: DaemonContext,
  project: Project,
  commandText: string,
  corePrompt: string,
  slashRisks: string[],
  chain: number,
  opts?: { resumeSessionId?: string; origin?: string; chat?: ChatRef; /** 被续的那条记录（按卡续时不是本群指针） */ prev?: LastRun },
): Promise<boolean> {
  const chatId = chatIdOf(opts?.chat);
  const rootId = rootIdOf(opts?.chat);
  const { port, log } = ctx;
  const release = await ctx.sem.acquire();
  const t0 = Date.now();
  // 输出语言必须钉死：实测出现过整段韩语回复直接进业务群。
  // 收尾问题必须编号带选项：这是续聊协议的另一半——答复要能对得上号。
  // 无人值守声明：实测会话被工具白名单拦下后，向群里喊「请在权限提示中点击允许」——那个提示不存在
  // 写权限声明（2026-08-25 实测）：会话排查出 14 个文件要改，向用户开出「是否现在授予写入权限」的选项——
  // 白名单钉死在 daemon 里，续聊也不会变，这个授权不存在。改代码的正路是 /new 建单走流水线（有评审有 CI）。
  const prompt = `${corePrompt}\n\n（结果会原样发到中文业务群，请全程用中文回复；结尾若有需要用户决定的问题，请逐条编号并给出可选项。你运行在无人值守环境：没有权限提示可点，工具不可用就是不可用——做不到的事直接说做不到，并给出替代路径。你没有 Edit/Write 工具，本会话与后续续聊都不会获得写权限，也不要用 Bash 改写仓库文件绕过限制——不要向用户提出「授予写入权限」这类不存在的选项；凡是要改代码的诉求，直接建议用户发「/new 一句话需求」建工单走流水线，并把你的排查结论浓缩进需求里）`;
  try {
    const r = await engineFor(project.repo).runText({
      cwd: project.repo,
      prompt,
      tools: 'Read,Grep,Glob,Bash,Skill,WebFetch',
      model: process.env.PIPELINE_RUN_MODEL ?? 'sonnet',
      maxTurns: 40,
      budgetUsd: Number(process.env.PIPELINE_RUN_BUDGET ?? 3),
      pluginDir: PLUGIN_DIR,
      resumeSessionId: opts?.resumeSessionId,
    });
    const at = new Date().toISOString();
    ctx.adhoc.push({ at, project: project.alias, text: commandText.slice(0, 200), costUsd: r.costUsd });
    const seconds = Math.round((Date.now() - t0) / 1000);
    // 输出必须落盘：只记字符数的话，事后想查"到底跑没跑成"只能去翻别人的聊天窗口
    const file = writeAdhocRecord({
      at,
      project: project.alias,
      command: commandText,
      prompt,
      output: r.text,
      costUsd: r.costUsd,
      turns: r.turns,
      seconds,
      isError: r.isError,
      sessionId: r.sessionId,
    });
    const tail = `$${r.costUsd.toFixed(2)} · ${r.turns} 轮 · ${seconds}s`;
    log(
      `/run ${r.isError ? '会话异常' : '完成'}：${tail}，输出 ${r.text.length} 字符${file ? ` → ${path.basename(file)}` : ''}`,
    );
    log(`  输出首行：${r.text.split('\n').find((l) => l.trim())?.slice(0, 160) ?? '(空)'}`);
    if (r.isError) {
      // 会话中途出错时 result 装的是报错文案。按"执行结果"发出去，等于把失败伪装成成功。
      // 续聊指针也不更新：从一段报错文案"接着办"没有意义
      await port.sendResult(
        `执行未完成 · ${project.alias}`,
        [
          `⚠️ **这次执行没有正常跑完**，下面是会话返回的错误：`,
          '',
          r.text,
          ...(slashRisks.length
            ? ['', `**这条指令有对外副作用（${slashRisks.join('、')}），中断位置未知——远端状态请自行确认后再重试。**`]
            : []),
        ].join('\n'),
        `${tail} · 失败，未产出结果`,
        opts?.chat,
      );
    } else {
      const rec: LastRun = {
        at,
        project: project.alias,
        command: commandText,
        output: r.text,
        chain,
        sessionId: r.sessionId,
        origin: opts?.origin ?? commandText,
        // 整段对话随指针累积：续轮接在被续的那条记录后面（按卡续时是那张卡的记录，否则是本群指针）
        transcript: withRound(chain > 0 ? (opts?.prev ?? readLastRunFor(chatId)) : null, { command: commandText, output: r.text }),
      };
      // 指针按群存（两个群同时聊不互相覆盖），全局那份仍写作兜底
      saveLastRunFor(chatId, rec);
      // 话题 = 会话：在话题里跑的这轮记到话题上，下一句不用引用卡、不用 /re 就能续（src/threads.ts）
      if (rootId && chatId) rememberThreadRun(rootId, chatId, rec);
      const mid = await port.sendResult(
        `执行结果 · ${project.alias}`,
        r.text,
        `${tail} · 单次执行，不建工单不入看板（要改代码走 /new；结尾有问题的话，在这张卡的话题里直接回复即可继续这次任务）`,
        opts?.chat,
      );
      // 这张卡 ↔ 这次会话：人日后引用它回话，精确续这个会话，不受指针与 TTL 限制
      if (mid) rememberRunCard(mid, rec);
    }
    return true;
  } catch (e) {
    // resume 的启动期失败（id 失效 → CLI 纯文本报错，走不到 JSON 解析）：不打扰群，交给调用方降级。
    // 已经跑起来再失败的（isError）不在此列——那时可能已产生副作用，绝不能静默重跑
    if (opts?.resumeSessionId) {
      log(`续聊 resume 失败（将降级为拼接模式）：${(e as Error).message.slice(0, 160)}`);
      return false;
    }
    log(`/run 失败：${(e as Error).message.slice(0, 200)}`);
    await port.notify('执行', `失败：${(e as Error).message.slice(0, 300)}`, opts?.chat);
    return false;
  } finally {
    release();
  }
}

/** 零输入建单的草拟：整段 /run 对话 → 一段需求原文。sonnet 纯文本一次调用，失败返回 null 由调用方兜底 */
export async function draftRequirementFromChat(ctx: DaemonContext, project: Project, last: LastRun): Promise<string | null> {
  try {
    const r = await engineFor(project.repo).runText({
      cwd: project.repo,
      prompt: composeRequirementDraftPrompt(last),
      tools: 'Read',
      model: 'sonnet',
      maxTurns: 3,
      budgetUsd: 0.5,
      pluginDir: PLUGIN_DIR,
    });
    ctx.log(`建单草拟：$${r.costUsd.toFixed(3)} · ${r.turns} 轮 · ${r.text.length} 字符${r.isError ? '（会话异常）' : ''}`);
    return r.isError || !r.text.trim() ? null : r.text.trim();
  } catch (e) {
    ctx.log(`建单草拟失败：${(e as Error).message.slice(0, 160)}`);
    return null;
  }
}

/** 续聊：把答复接回上一次单次执行——优先 --resume 真续会话，失败降级拼接（见 followup.ts 头注） */
export async function runFollowup(ctx: DaemonContext, reply: string, chat?: ChatRef, quotedMessageId?: string): Promise<void> {
  const { port, projects, cfg, log } = ctx;
  const chatId = chatIdOf(chat);
  const rootId = rootIdOf(chat);
  // 续谁（设计稿 §3.4）：引用的结果卡 > 话题自己的会话 > 话题根就是一张结果卡 > 本群指针（再退全局）
  const byCard = runByCard(quotedMessageId);
  if (byCard) log(`按引用的结果卡续会话：${describeLastRun(byCard)}（项目 ${byCard.project}）`);
  const th = getThread(rootId);
  let last = byCard ?? th?.run ?? runByCard(rootId) ?? readLastRunFor(chatId);
  // 会话寿命（30 轮 / 7 天）：到期就不 --resume 了，新会话第一句带上旧会话的摘要
  if (th?.run && last === th.run && !sessionFresh(th)) {
    log(`话题会话到期（${th.turns} 轮，最近 ${th.lastAt}），重开新会话并带摘要`);
    await port.notify('执行', '这个话题的会话已到期（超 30 轮或 7 天没动），我重开一个新会话接着聊，带上之前的摘要。', chat);
    last = { ...th.run, sessionId: undefined, output: expiredSessionBrief(th) ?? th.run.output.slice(0, 600) };
  }
  if (!last) {
    // 24 小时 TTL 是为「隔天回个 1」这种含糊答复设的；人明确打了 /re 就该问一句而不是直接拒（2026-09-04 实测：
    // 用户隔了两天带着三条答复回来，被一句「没有可继续的记录」挡住，又换自然语言重发一遍）
    const stale = readLastRunFor(chatId, Date.now(), Number.POSITIVE_INFINITY);
    if (!stale) {
      await port.notify('执行', '最近没有可继续的单次执行记录。直接用 /run 重新说清要做的事即可。', chat);
      return;
    }
    const CONT = '接着它';
    const pick = await port.chooseOption(
      '执行',
      `最近 24 小时内没有可继续的单次执行；再往前一次是 ${describeLastRun(stale)}（项目 ${stale.project}）。你的这句要接在它后面吗？\n> ${reply.slice(0, 120)}`,
      [CONT, '不是，我重新 /run'],
      chat,
    );
    if (pick !== CONT) {
      await port.notify('执行', '好，那请用 /run 把要做的事连同背景一起说清，我从头开始。', chat);
      return;
    }
    last = stale;
  }
  const project = resolveProject(projects, last.project) ?? resolveProject(projects, cfg.defaultProject);
  if (!project) {
    await port.notify('执行', `无法确定项目（可用：${describeProjects(projects)}）`, chat);
    return;
  }
  const origin = last.origin ?? last.command;
  log(`续聊（第 ${last.chain + 1} 轮${last.sessionId ? '，resume' : '，拼接'}）on ${project.alias}: ${reply.slice(0, 80)}`);
  await port.notify('执行', `继续上次执行 ${describeLastRun(last)}，已带上你的答复…`, chat);
  if (last.sessionId) {
    // 真续会话：完整历史在会话里，正文只需要答复本身
    if (await execAdhoc(ctx, project, reply, reply, [], last.chain + 1, { resumeSessionId: last.sessionId, origin, chat, prev: last })) return;
    log('  resume 未成功，改用拼接模式重试');
  }
  await execAdhoc(ctx, project, reply, composeFollowupPrompt(last, reply), [], last.chain + 1, { origin, chat, prev: last });
}
