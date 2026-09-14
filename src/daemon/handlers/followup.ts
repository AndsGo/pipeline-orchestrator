import { readLastRunFor } from '../../followup.js';
import { type ChatRef, chatIdOf, rootIdOf } from '../../ports.js';
import { readSticky } from '../../sticky.js';
import type { CommandOf, DaemonContext } from '../context.js';
import { handle as runHandle } from './run.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'followup'>, sender: string, chat?: ChatRef): Promise<void> {
  const { port, log } = ctx;
  // 主线续聊（没引用卡、不在话题）而本群刚 /bind 到别的项目：上次会话属于另一个项目，不该悄悄续它。
  // 2026-09-13 真机：速卖通刊登问题先按默认项目在 lakeghost 跑了一轮，用户 /bind odoo-product 后把原话重发，
  // 被判续聊（85%）又续回 lakeghost——/bind 白做了
  if (!c.quotedMessageId && !rootIdOf(chat)) {
    const chatId = chatIdOf(chat);
    // 本群的项目：绑定（/bind）优先，其次粘性（/use）——2026-09-14 真机：/use odoo-product 后一句「分析下这个问题」仍续回 lakeghost
    const bound = ctx.projects.find((p) => p.chatId === chatId) ?? (chatId ? readSticky(chatId, ctx.projects) : null);
    const last = chatId ? readLastRunFor(chatId) : null;
    if (bound && last && last.project !== bound.alias) {
      log(`本群当前项目 ${bound.alias}，上次会话属于 ${last.project}：这句按新任务在 ${bound.alias} 上执行`);
      await port.notify('执行', `本群当前项目是 **${bound.alias}**，上次会话属于 ${last.project}，这句按新任务在 ${bound.alias} 上执行。`, chat);
      await runHandle(ctx, { kind: 'run', text: c.text, project: bound.alias, sideEffect: c.sideEffect }, sender, chat);
      return;
    }
  }
  // 续聊同样能触发部署/推送（"好，推吧"）：闸门认的是意图，不是斜杠语法，也不因为它是续聊就免检。
  // 话题里 run → followup 的路由更要守住这一关（2026-09-10）
  if (c.sideEffect) {
    log(`续聊判定为有对外副作用，先确认：${c.text.slice(0, 80)}`);
    const what = [
      '即将接着上次会话执行（自然语言指令）：',
      '',
      `> ${c.text.slice(0, 300)}`,
      '',
      '⚠️ 我判断这件事**会影响本机之外的东西**（部署／推送／发布之类）。',
      '这不是预先写好的命令，**具体会跑什么由会话临场决定，我无法提前列出**。',
      '',
      '_单次执行：有 Bash 权限、不建工单、不进流水线评审。取消不会有任何改动。_',
    ].join('\n');
    if (!(await port.confirmCommand('执行', what, chat))) {
      log('续聊已取消（自然语言副作用指令）');
      await port.notify('执行', '已取消，没有任何改动', chat);
      return;
    }
  }
  await ctx.runFollowup(c.text, chat, c.quotedMessageId);
}
