import { beforeEach, expect, it, vi } from 'vitest';
const runJson = vi.hoisted(() => vi.fn());
vi.mock('../engine/index.js', () => ({ engineFor: () => ({ runJson }) }));
import { classifyCommand } from '../commands.js';
beforeEach(() => { runJson.mockReset(); });
it('does not retry a deterministic execution identity failure', async () => {
  runJson.mockRejectedValue(new Error('执行配置检查失败：CLI 版本已变化'));
  const result = await classifyCommand('验收下', []);
  expect(result.error).toContain('执行配置检查失败');
  expect(runJson).toHaveBeenCalledTimes(1);
});
it('still retries a transient classifier failure', async () => {
  runJson.mockRejectedValue(new Error('temporary connection failure'));
  const result = await classifyCommand('验收下', []);
  expect(result.error).toBe('temporary connection failure');
  expect(runJson).toHaveBeenCalledTimes(2);
});
