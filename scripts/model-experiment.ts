// implement 主会话模型的对照实验读数器。
//   npx tsx scripts/model-experiment.ts
//
// ── 实验协议（2026-08-24 排入）────────────────────────────────────────────────
// 问题：implement 现在是「主会话 opus + 子代理 haiku/sonnet 分层」。主会话干的是派活、
// 读评审、仲裁——未必需要最强模型。但省下的钱可能从评审回环里加倍还回来，所以要实测。
//
// 怎么跑：
//   1. 想让接下来的工单进 sonnet 臂 → 在 .env 里设 PIPELINE_IMPLEMENT_MODEL=sonnet
//      后重启 daemon；想回 opus 臂 → 删掉该行再重启。臂在首次 implement 时冻结进工单
//      （state.implementModel），中途改环境变量不会污染已开工的单。
//   2. 两臂尽量交替、且工单形状可比（都别拿一个 9 任务的大单去比一个改文案的小单）。
//      每臂建议至少 3 单再看数——1 单的差异基本是工单难度差异，不是模型差异。
//   3. 跑本脚本读数。
//
// 判据（先写下来，避免事后按结果找理由）：
//   sonnet 臂要同时满足以下三条才算可采纳，否则维持 opus——
//   a. 评审一次通过率不低于 opus 臂（容差：低 1 个工单以内）；
//   b. 平均评审修复轮不高于 opus 臂 + 0.5；
//   c. 单工单 implement 总成本确有下降（否则换它没有意义）。
//   任一条不满足 = 省下的会话费被回环吃掉，实验结论是「不换」。
//
// 注意：model 字段是 2026-08-24 才加的，此前的运行记录没有它——脚本把它们单独归到
// 「未记录」组，不替历史数据假设模型（当时 implement 一直是 opus，但那是靠 config.ts
// 的 git 历史推断的，不是记录，别把推断混进对照数据）。
//
// 更要紧的是：那 9 单**不能当 opus 臂用**。同在 2026-08-24，implement 的行为被改了两处——
// 子代理模型分层从建议升为硬约束（plugin a2318e0）、推理档位钉死为 high（75dd74f）。
// 拿改造前的 opus 数据去比改造后的 sonnet 数据，测出来的是这三件事的合力，不是模型差异。
// 所以两臂都要在今天之后重新采集；「未记录」那一行只作参考背景，不进判据。
import { computeMetrics, readAllSnapshots } from '../src/metrics.js';
import type { TicketState } from '../src/types.js';

const UNRECORDED = '未记录（早于 model 字段）';

const states = readAllSnapshots() as TicketState[];
const withImplement = states.filter((s) => s.runs.some((r) => r.stage === 'implement'));

const arms = new Map<string, TicketState[]>();
for (const s of withImplement) {
  // 优先用冻结的实验臂；没有就看运行记录里实际落账的模型
  const arm = s.implementModel ?? s.runs.find((r) => r.stage === 'implement' && r.model)?.model ?? UNRECORDED;
  const list = arms.get(arm) ?? [];
  list.push(s);
  arms.set(arm, list);
}

if (!arms.size) {
  console.log('还没有跑过 implement 的工单。');
  process.exit(0);
}

const rows = [...arms.entries()]
  .sort((a, b) => (a[0] === UNRECORDED ? 1 : b[0] === UNRECORDED ? -1 : a[0].localeCompare(b[0])))
  .map(([arm, list]) => {
    const impl = list.flatMap((s) => s.runs.filter((r) => r.stage === 'implement'));
    const m = computeMetrics(list);
    const cost = impl.reduce((sum, r) => sum + r.costUsd, 0);
    const blocked = impl.filter((r) => r.status === 'BLOCKED').length;
    return {
      臂: arm,
      工单数: list.length,
      'implement 会话数/单': (impl.length / list.length).toFixed(1),
      'implement 成本/单': `$${(cost / list.length).toFixed(2)}`,
      挂起次数: blocked,
      评审一次通过: m.reviewSamples ? `${m.firstPassReview}/${m.reviewSamples}` : '—',
      平均修复轮: m.reviewSamples ? (m.totalReviewFixRounds / m.reviewSamples).toFixed(1) : '—',
      验收返工: m.acceptanceSamples ? `${m.acceptanceReworked}/${m.acceptanceSamples}` : '—',
      工单: list.map((s) => s.ticket).join(','),
    };
  });

console.table(rows);

const real = rows.filter((r) => r.臂 !== UNRECORDED);
if (real.length < 2) {
  console.log('\n只有一个臂有数据——另一臂的跑法见本文件头部协议。');
} else if (real.some((r) => r.工单数 < 3)) {
  console.log('\n⚠ 有臂的样本不足 3 单：此时的差异更可能来自工单难度而非模型，先别下结论。');
} else {
  console.log('\n按文件头的三条判据逐条对照（一次通过率 / 修复轮 / 成本），任一条不满足即维持 opus。');
}
