import { buildDashboard, renderDashboard, type TicketRow } from '../../dashboard.js';
import { listTickets, readEvents, totalCost } from '../../events.js';
import { computeMetrics, metricsDashItems, readAllSnapshots } from '../../metrics.js';
import { readSnapshot } from '../../ticket.js';
import type { CommandOf, DaemonContext } from '../context.js';

export async function handle(ctx: DaemonContext, _c: CommandOf<'dashboard'>, _sender: string, chat?: string): Promise<void> {
  const { port, active, sem, cfg, adhoc } = ctx;
  const rows: TicketRow[] = listTickets().map((t) => {
    const st = readSnapshot(t);
    const evs = readEvents(t);
    const closed = st?.runs.some((r) => r.stage === 'compound' && r.status === 'DONE');
    return {
      ticket: t,
      project: st?.project,
      stage: closed ? '已闭环' : (st?.cursor ?? '?'),
      state: active.has(t) ? '在跑' : st?.haltedReason ? '挂起' : closed ? '闭环' : '等人工',
      cost: totalCost(t) || (st?.runs.reduce((s, r) => s + r.costUsd, 0) ?? 0),
      waiting: st?.haltedReason
        ? `挂起：${st.haltedReason}`
        : port.pendingLabels(t).length
          ? `等回答：${port.pendingLabels(t).join('、')}`
          : evs.at(-1)?.summary,
    };
  });
  const d = buildDashboard(process.env, {
    startedAt: ctx.startedAt,
    now: Date.now(),
    concurrency: { inUse: sem.inUse, max: cfg.maxConcurrency, waiting: sem.waiting },
    activeTickets: [...active.keys()],
    pendingCards: port.pendingLabels().length,
    boardEnabled: ctx.boardOn,
    adhoc: { count: adhoc.length, cost: adhoc.reduce((a, x) => a + x.costUsd, 0) },
  }, rows, metricsDashItems(computeMetrics(readAllSnapshots())));
  const r = renderDashboard(d);
  await port.sendDashboard(r.config, r.runtime, r.tickets, chat);
}
