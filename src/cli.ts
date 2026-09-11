// 单工单一次性运行（daemon 之外的轻量入口 / 调试用）
// 用法: npm run orchestrate -- <repoPath> <ticketId> [--start <stage>] [--requirement "..."] [--lane fast|full] [--feishu|--auto]
import { initBitableSync } from './bitable/sync.js';
import { FeishuPort, feishuConfigFromEnv } from './feishu/port.js';
import type { Lane } from './lanes.js';
import { acquireLock, findOrphanClaude, releaseLock, killHint } from './lock.js';
import { clearPaused } from './pause.js';
import { AutoPort, CliPort } from './ports.js';
import { runTicket } from './ticketRunner.js';
import type { Stage } from './types.js';

function usage(): never {
  console.error(
    '用法: npm run orchestrate -- <repoPath> <ticketId> [--start <stage>] [--requirement "需求原文"] [--lane fast|full] [--feishu|--auto]',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2) usage();
  const [repo, ticket] = argv;
  const pick = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  // 工单级互斥：双控制器同时改一个仓库是最危险的故障
  const lock = acquireLock(ticket);
  if (!lock.ok) {
    console.error(
      `工单 ${ticket} 已有编排器实例在运行（pid ${lock.holder.pid}，始于 ${lock.holder.startedAt}）。确认其已死可删除 data/${ticket}.lock`,
    );
    process.exit(1);
  }
  const orphans = findOrphanClaude(ticket);
  if (orphans.length) {
    console.error('检测到本工单的存活 claude 进程（可能是上次运行的孤儿），先处理再启动：');
    for (const o of orphans) console.error(`  pid ${o.pid}: ${o.cmd}`);
    console.error(`确认后可 ${killHint()} 清理`);
    releaseLock(ticket);
    process.exit(1);
  }

  clearPaused(ticket); // 启动即恢复
  initBitableSync(() => true); // 单工单模式：本进程在跑就是"在跑"
  const port = argv.includes('--feishu')
    ? await FeishuPort.create(feishuConfigFromEnv())
    : argv.includes('--auto')
      ? new AutoPort()
      : new CliPort();

  try {
    await runTicket({
      repo,
      ticket,
      port,
      startStage: (pick('--start') as Stage) ?? undefined,
      requirement: pick('--requirement'),
      lane: pick('--lane') as Lane | undefined,
    });
  } finally {
    releaseLock(ticket);
    port.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
