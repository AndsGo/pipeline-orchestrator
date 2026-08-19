import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 轻量续聊协议：让 /run 收尾的提问有一条"答案回得去的路"。
 *
 * /run 会话是一次性的——结尾若向人提了问题（要不要 push、未跟踪目录怎么处理），
 * 问题只存在于结果卡的文字里：没有待答卡、没有可续的会话，用户的回复会被分类器
 * 判成 answer 后因无处投递而石沉大海（实测事故）。
 *
 * 修法不是保活会话（占并发闸门、人几小时不回就资源悬挂），而是：
 * 记住最近一次执行 → 收到答复时开一个新会话，把上次任务 + 上次完整输出 + 答复
 * 拼进提示词。对模型来说就是带记忆的第二轮，成本只多一次上下文注入。
 */

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/last-run.json');

/** 续聊有效期：隔天再回"1"大概率已不是在回上次的问题，宁可让人重新说清 */
export const FOLLOWUP_TTL_MS = 24 * 60 * 60 * 1000;

/** 上次输出注入续聊提示词的截断上限。收尾问题在末尾——截头保尾 */
const OUTPUT_CAP = 20_000;

export interface LastRun {
  /** ISO 时间（该轮执行完成时刻） */
  at: string;
  /** 项目别名（续聊要回到同一个仓库） */
  project: string;
  /** 该轮的用户原话：首轮 = /run 指令，续轮 = 答复 */
  command: string;
  /** 会话完整输出（含收尾问题） */
  output: string;
  /** 续聊轮次：首轮 0，每续一次 +1 */
  chain: number;
}

/** 落盘最近一次执行指针（写失败不抛——指针丢了只是续不上聊，不能反过来影响结果送达） */
export function saveLastRun(r: LastRun, file = FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r), 'utf-8');
  } catch {
    /* 见上 */
  }
}

/** 读最近一次执行；无记录、损坏或超过 TTL 都返回 null（落盘是为了熬过看门狗重启 daemon） */
export function readLastRun(now = Date.now(), file = FILE): LastRun | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as LastRun;
    if (!r?.at || typeof r.output !== 'string' || typeof r.command !== 'string') return null;
    if (now - Date.parse(r.at) > FOLLOWUP_TTL_MS) return null;
    return r;
  } catch {
    return null;
  }
}

/** 卡片/日志里指代上次执行的短句：《指令前 60 字》（N 分钟前） */
export function describeLastRun(r: LastRun, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(r.at)) / 60_000));
  const ago = min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
  return `《${r.command.slice(0, 60)}》（${r.chain > 0 ? `续聊第 ${r.chain} 轮，` : ''}${ago}）`;
}

/** 把"上次任务 + 上次输出 + 这次答复"拼成续聊会话的正文 */
export function composeFollowupPrompt(last: LastRun, reply: string): string {
  const clipped =
    last.output.length > OUTPUT_CAP
      ? `…（前文过长已截断，以下是输出的末尾部分）\n${last.output.slice(-OUTPUT_CAP)}`
      : last.output;
  return [
    '你之前在本仓库执行过一次任务，结尾向用户提出了待决问题；现在用户回复了。',
    '请基于下面的记录接着办完，已完成的部分不要重做。',
    '',
    '## 上次任务（用户原话）',
    last.command,
    '',
    '## 上次执行的完整输出',
    clipped,
    '',
    '## 用户这次的答复',
    reply,
    '',
    '按答复继续执行。答复没有覆盖到的待决问题：先办已明确的部分，结尾把仍未决的项重新逐条编号列出。',
  ].join('\n');
}
