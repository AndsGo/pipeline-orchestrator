import type { Command } from '../../commands.js';
import type { ChatRef } from '../../ports.js';
import type { CommandOf, DaemonContext } from '../context.js';
import * as addproject from './addproject.js';
import * as amend from './amend.js';
import * as answer from './answer.js';
import * as bind from './bind.js';
import * as dashboard from './dashboard.js';
import * as followup from './followup.js';
import * as help from './help.js';
import * as list from './list.js';
import * as newTicket from './new.js';
import * as note from './note.js';
import * as pause from './pause.js';
import * as resume from './resume.js';
import * as rewind from './rewind.js';
import * as run from './run.js';
import * as status from './status.js';
import * as unknown from './unknown.js';
import * as use from './use.js';

export type Handler<K extends Command['kind']> = (ctx: DaemonContext, cmd: CommandOf<K>, sender: string, chat?: ChatRef) => Promise<void>;

/** kind → 处理器。映射类型按 Command['kind'] 穷举：新增一种指令没配处理器，tsc 直接报错 */
export const handlers: { [K in Command['kind']]: Handler<K> } = {
  help: help.handle,
  dashboard: dashboard.handle,
  list: list.handle,
  status: status.handle,
  pause: pause.handle,
  resume: resume.handle,
  note: note.handle,
  amend: amend.handle,
  rewind: rewind.handle,
  run: run.handle,
  followup: followup.handle,
  new: newTicket.handle,
  use: use.handle,
  bind: bind.handle,
  addproject: addproject.handle,
  answer: answer.handle,
  unknown: unknown.handle,
};

/** 按 kind 分发。断言是安全的：映射类型已保证 handlers[k] 收的就是 kind 为 k 的指令 */
export function dispatch(ctx: DaemonContext, c: Command, sender: string, chat?: ChatRef): Promise<void> {
  return (handlers[c.kind] as Handler<Command['kind']>)(ctx, c, sender, chat);
}
