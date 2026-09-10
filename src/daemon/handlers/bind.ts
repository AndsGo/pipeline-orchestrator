import { describeProjects, resolveProject } from '../../projects.js';
import { type ChatRef, chatIdOf } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';
import { commitProjectsEnv, readProjectsEnv } from '../projectsEnv.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'bind'>, _sender: string, ref?: ChatRef): Promise<void> {
  const chat = chatIdOf(ref);
  const { port, projects, log } = ctx;
  if (!chat) return;
  if (chat === ctx.MAIN_CHAT) {
    await port.notify('项目', '主群保持综合入口，不绑定单一项目。要绑定请在目标项目的群里发 /bind', chat);
    return;
  }
  const target = resolveProject(projects, c.alias);
  if (!target) {
    await port.notify('项目', `没有叫「${c.alias}」的项目（可用：${describeProjects(projects)}）`, chat);
    return;
  }
  // 持久化：chatId 写进 PIPELINE_PROJECTS 该项目条目（.env 备份后精确改一行），并热加载
  const { envText, current } = readProjectsEnv(ctx.envFile);
  if (!current) {
    await port.notify('项目', '.env 里没有 PIPELINE_PROJECTS，无法绑定', chat);
    return;
  }
  const raw = JSON.parse(current) as Record<string, Record<string, unknown>>;
  const prevOwner = projects.find((p) => p.chatId === chat && p.alias !== target.alias);
  if (prevOwner) delete raw[prevOwner.alias].chatId; // 一群一项目：改绑即解除旧绑定
  raw[target.alias].chatId = chat;
  commitProjectsEnv(ctx, envText, JSON.stringify(raw));
  log(`群 ${chat.slice(0, 12)}… 绑定项目 ${target.alias}${prevOwner ? `（解除原绑定 ${prevOwner.alias}）` : ''}`);
  await port.notify(
    '项目',
    `✅ 本群已绑定 **${target.alias}**：在这里说的消息默认归它，${target.prefix}- 工单的通知与卡片也会发到这里${prevOwner ? `（已解除本群与 ${prevOwner.alias} 的原绑定）` : ''}。`,
    chat,
  );
}
