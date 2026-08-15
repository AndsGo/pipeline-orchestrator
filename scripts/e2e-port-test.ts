// FeishuPort 真机联调：发通知 + 发卡点卡片 + 长连接等待点击回调
import { FeishuPort, feishuConfigFromEnv } from '../src/feishu/port.js';

const TIMEOUT_MIN = 10;

const port = await FeishuPort.create(feishuConfigFromEnv());
console.log('[e2e] WebSocket 长连接已启动');

await port.notify('联调', 'FeishuPort 真机联调开始：即将发送一张测试卡片，请在飞书里点击按钮');
console.log('[e2e] 通知消息已发送');

const timer = setTimeout(() => {
  console.log(`[e2e] FAIL：${TIMEOUT_MIN} 分钟内未收到卡片回调`);
  process.exit(1);
}, TIMEOUT_MIN * 60 * 1000);

const approved = await port.confirmGate(
  '联调',
  'connectivity-test',
  '**这是 FeishuPort 真机联调卡片。**\n请点击下方任一按钮——点击后卡片应变绿显示"已处理"，终端应收到回调。',
  ['这是一条测试 concern，验证列表渲染'],
);
clearTimeout(timer);
console.log(`[e2e] PASS：收到回调，decision = ${approved ? 'approve' : 'reject'}`);
await port.notify('联调', `回调链路验证通过（你点了${approved ? '通过' : '驳回'}）。FeishuPort 联调完成 ✔`);
process.exit(0);
