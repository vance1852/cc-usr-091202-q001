/**
 * 历史取号记录的峰谷/爽约统计。
 * 历史数据仅用于导办决策参考（例如傍晚提示收号），不参与当日容量计算。
 */
export function historyStats(history) {
  const records = history?.records ?? [];
  const groups = new Map();
  for (const r of records) {
    const key = `${r.windowId}|${r.slotId}|${r.serviceCode}`;
    let g = groups.get(key);
    if (!g) {
      g = { windowId: r.windowId, slotId: r.slotId, serviceCode: r.serviceCode, days: 0, issued: 0, served: 0, noShow: 0, cancelled: 0 };
      groups.set(key, g);
    }
    g.days += 1;
    g.issued += r.issued ?? 0;
    g.served += r.served ?? 0;
    g.noShow += r.noShow ?? 0;
    g.cancelled += r.cancelled ?? 0;
  }
  const rows = [...groups.values()].map((g) => ({
    ...g,
    avgIssued: round2(g.issued / g.days),
    noShowRate: g.issued ? round2(g.noShow / g.issued) : 0,
    fillRate: g.issued ? round2((g.served + g.noShow) / g.issued) : 0,
  }));
  rows.sort((a, b) => b.noShowRate - a.noShowRate);
  return { sourceDays: new Set(records.map((r) => r.date)).size, rows };
}

/** 某日全部窗口时段的实况汇总 */
export function dailyAggregate(service, date) {
  const overview = service.overview(date);
  const totals = overview.slots.reduce(
    (acc, s) => {
      acc.capacity += s.capacity;
      acc.used += s.used;
      acc.remaining += Math.max(0, s.remaining);
      acc.displaced += s.displaced;
      acc.served += s.served;
      acc.noShow += s.noShow;
      acc.cancelled += s.cancelled;
      if (s.suspended) acc.suspendedSlots += 1;
      return acc;
    },
    { capacity: 0, used: 0, remaining: 0, displaced: 0, served: 0, noShow: 0, cancelled: 0, suspendedSlots: 0 }
  );
  return { date, open: overview.open, reason: overview.reason, ...totals };
}

function round2(n) {
  return Math.round(n * 1000) / 1000;
}
