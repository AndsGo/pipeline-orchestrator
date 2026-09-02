import { describe, expect, it } from 'vitest';
import { isTransientApiError, TRANSIENT_RETRY_DELAY_MS } from '../transient.js';

describe('isTransientApiError（OP-002 实测：529 Overloaded 让修复轮白等人）', () => {
  it('过载 / 网关 / 限流 / 连接类错误 → 瞬时', () => {
    expect(isTransientApiError('API Error: 529 Overloaded. This is a server-side issue, usually temporary')).toBe(true);
    expect(isTransientApiError('API Error: 503 Service Unavailable')).toBe(true);
    expect(isTransientApiError('429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit')).toBe(true);
    expect(isTransientApiError('request to https://api.anthropic.com failed, reason: read ECONNRESET')).toBe(true);
    expect(isTransientApiError('TypeError: fetch failed')).toBe(true);
  });

  it('模型的正常失败与其它错误不算瞬时——那些重试也不会好', () => {
    expect(isTransientApiError('无结构化返回')).toBe(false);
    expect(isTransientApiError('API Error: 400 invalid_request_error: prompt is too long')).toBe(false);
    expect(isTransientApiError('API Error: 401 authentication_error')).toBe(false);
    expect(isTransientApiError('Credit balance is too low')).toBe(false);
    expect(isTransientApiError('会话在第 5 轮被工具白名单拦下')).toBe(false);
  });

  it('等待时长是分钟级：太短等于原地再撞', () => {
    expect(TRANSIENT_RETRY_DELAY_MS).toBeGreaterThanOrEqual(60_000);
  });
});
