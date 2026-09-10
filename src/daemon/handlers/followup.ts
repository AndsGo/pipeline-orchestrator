import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, c: CommandOf<'followup'>, _sender: string, chat?: ChatRef): Promise<void> {
  const { port, log } = ctx;
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
