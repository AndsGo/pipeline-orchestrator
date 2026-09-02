/**
 * 瞬时故障判定：会话异常里哪些是「服务端/网络抖一下」而不是「这一单有问题」。
 * 由来（OP-002 2026-09-02）：review 修复轮跑了 30 分钟撞上 `API Error: 529 Overloaded`，runner 退出等人说
 * 「继续」——人不在，工单就干等；而 529 的正确处理就是过几分钟再来一次。
 * 词面故意收窄：只认明确的过载/网关/连接类错误，模型说「我做不到」之类的正常失败不在此列。
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\b529\b/, // Anthropic overloaded
  /overloaded/i,
  /\b(502|503|504)\b/, // 网关/暂不可用/超时
  /rate[ _-]?limit/i,
  /\b429\b/,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed/i,
];

export function isTransientApiError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}

/** 自动重试前的等待：过载通常几分钟内缓解，太短等于原地再撞一次 */
export const TRANSIENT_RETRY_DELAY_MS = 3 * 60 * 1000;
