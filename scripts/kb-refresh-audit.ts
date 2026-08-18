// 知识库 refresh 审计（建议每月一跑）：老化报告 + 可选的模型对照代码库深检。
// 依据业界教训：模型识别「记忆已过时」准确率仅 ~55%，过时判断要靠制度化审计而不是运行时指望模型。
//   npx tsx scripts/kb-refresh-audit.ts                     # 老化报告（零成本）
//   npx tsx scripts/kb-refresh-audit.ts --deep D:/work/repo # 加模型深检：逐条对照该仓库现状（约 $1-2）
// 审计只提建议不动数据——下线（状态→已失效）由人在知识表操作。
import { BitableBoard } from '../src/bitable/client.js';
import { lastHitByTitle } from '../src/hits.js';
import { runClaudeText } from '../src/runner.js';

const board = BitableBoard.fromEnv();
if (!board) {
  console.error('未配置 BITABLE_*（需要知识表）');
  process.exit(1);
}

const entries = await board.listKnowledge();
const hits = lastHitByTitle('knowledge');
const now = Date.now();
const days = (ts?: string): number | null => (ts ? Math.floor((now - new Date(ts).getTime()) / 86400000) : null);

console.log(`知识条目 ${entries.length} 条（命中日志自 knowledge-hits.jsonl）\n`);
console.log('状态   | 最近命中   | 标题');
console.log('-------|-----------|-----');
const stale: typeof entries = [];
for (const e of [...entries].sort((a, b) => (hits.get(a.title) ?? '') < (hits.get(b.title) ?? '') ? -1 : 1)) {
  const d = days(hits.get(e.title));
  const hitStr = d === null ? '从未命中' : d === 0 ? '今天' : `${d} 天前`;
  console.log(`${(e.status ?? '生效').padEnd(5)} | ${hitStr.padEnd(9)} | ${e.title.slice(0, 60)}`);
  if ((!e.status || e.status === '生效') && (d === null || d > 30)) stale.push(e);
}
console.log(`\n候选关注：${stale.length} 条生效条目超过 30 天未命中或从未命中（命中日志启用于 2026-08-18，早期"从未命中"属正常）`);

const deepIdx = process.argv.indexOf('--deep');
if (deepIdx !== -1) {
  const repo = process.argv[deepIdx + 1];
  if (!repo) {
    console.error('--deep 需要仓库路径');
    process.exit(1);
  }
  const active = entries.filter((e) => !e.status || e.status === '生效');
  console.log(`\n深检 ${active.length} 条生效条目（对照 ${repo} 现状）…`);
  const list = active
    .map((e, i) => `${i + 1}. 【${e.title}】现象：${e.symptom}｜根因：${e.cause}｜做法：${e.practice}`)
    .join('\n');
  const { text, costUsd } = await runClaudeText({
    cwd: repo,
    prompt:
      `以下是团队知识库中标记为「生效」的经验条目。请逐条对照当前代码库验证它还成立吗：` +
      `描述的文件/配置/行为是否仍是那样？已被修复或重构的条目应提请下线。\n\n${list}\n\n` +
      `输出：仅列出【建议下线】或【需要更新措辞】的条目——编号+标题+一句话依据（引用 file:line）；全部仍成立就说"全部仍成立"。用中文。`,
    tools: 'Read,Grep,Glob',
    model: 'sonnet',
    maxTurns: 60,
    budgetUsd: 2,
  });
  console.log(`\n===== 深检结论（$${costUsd.toFixed(2)}）=====\n${text}`);
  console.log('\n处置：在飞书知识表把对应条目「状态」改为「已失效」（保留历史，不删）。');
}
