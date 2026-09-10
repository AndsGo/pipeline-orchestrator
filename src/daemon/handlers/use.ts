import { describeProjects, mentionedProject, resolveProject } from '../../projects.js';
import { readSticky, STICKY_TTL_MS, writeSticky } from '../../sticky.js';
import { type ChatRef, chatIdOf } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'use'>, _sender: string, ref?: ChatRef): Promise<void> {
  const chat = chatIdOf(ref);
  const { port, projects, cfg } = ctx;
  if (!chat) return;
  const bound = projects.find((p) => p.chatId === chat);
  if (bound) {
    await port.notify('项目', `本群已绑定 **${bound.alias}**，消息默认归它，无需 /use`, chat);
    return;
  }
  if (!c.alias) {
    const cur = readSticky(chat, projects);
    await port.notify(
      '项目',
      cur
        ? `本群当前上下文：**${cur.alias}**（${Math.round(STICKY_TTL_MS / 3600_000)} 小时内说的话默认归它）`
        : `本群当前无项目上下文，消息默认归 **${cfg.defaultProject}**。可用 /use 别名 切换（可用：${describeProjects(projects)}）`,
      chat,
    );
    return;
  }
  const target = resolveProject(projects, c.alias) ?? mentionedProject(projects, c.alias)?.project ?? null;
  if (!target) {
    await port.notify('项目', `没有叫「${c.alias}」的项目（可用：${describeProjects(projects)}）`, chat);
    return;
  }
  writeSticky(chat, target.alias);
  await port.notify('项目', `好，本群后续消息默认按 **${target.alias}** 处理（${Math.round(STICKY_TTL_MS / 3600_000)} 小时内有效；换项目再 /use 一次）`, chat);
}
