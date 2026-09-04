import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

/**
 * 单次执行（/run）的落盘留痕。
 *
 * 为什么值得单独一个文件：工单有事件日志、有看板、有交付文档，唯独 /run 两头不沾——
 * 结果只发到飞书卡片，服务端只记了个字符数。等到要排查"那次到底跑没跑成"时，
 * 唯一的证据在别人的聊天窗口里，我只能靠猜。已经因为这个误判过一次。
 */

const adhocDir = (): string => path.join(dataDir(), 'adhoc');

/** 文件名安全的短标识：取指令前几十个字符 */
function slug(text: string): string {
  return (
    text
      .replace(/^\s*\//, '')
      .slice(0, 40)
      .replace(/[^\w一-龥-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'run'
  );
}

export interface AdhocRecord {
  at: string;
  project: string;
  command: string;
  /** 实际发给模型的提示词（可能含知识摘要），与 command 区分开 */
  prompt: string;
  output: string;
  costUsd: number;
  turns: number;
  seconds: number;
  /** 会话本身报错（如中途断线）——此时 output 里是报错文案，不是执行结果 */
  isError: boolean;
  /** claude/codex 会话 id：留痕里有它，哪天指针丢了也能人工 --resume 回去 */
  sessionId?: string;
}

/** 落盘一条执行记录，返回文件路径（写失败返回 null——留痕失败不能反过来影响执行结果的送达） */
export function writeAdhocRecord(r: AdhocRecord): string | null {
  try {
    const dir = adhocDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${r.at.replace(/[:.]/g, '-')}-${slug(r.command)}.md`);
    fs.writeFileSync(
      file,
      [
        `# /run ${r.command}`,
        '',
        `- 结果：${r.isError ? '**会话异常（未正常跑完）**' : '正常完成'}`,
        `- 时间：${r.at}`,
        `- 项目：${r.project}`,
        ...(r.sessionId ? [`- 会话：${r.sessionId}`] : []),
        `- 成本：$${r.costUsd.toFixed(2)}｜轮次：${r.turns}｜耗时：${r.seconds}s`,
        '',
        '## 提示词',
        '',
        '```',
        r.prompt,
        '```',
        '',
        '## 输出',
        '',
        r.output,
        '',
      ].join('\n'),
      'utf-8',
    );
    return file;
  } catch {
    return null;
  }
}
