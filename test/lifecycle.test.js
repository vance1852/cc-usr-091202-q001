import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { makeApp, fakeClock, ref, root } from "./helpers.js";

const DATE = "2026-10-08";

test("时段结束后未到场的票记为爽约并释放号源", async () => {
  const clock = fakeClock("2026-10-08T16:00:00");
  const app = await makeApp(clock.now);
  try {
    const t1 = await app.service.book({ applicantRef: ref(1), serviceCode: "SC-DJ-04", date: DATE, windowId: "W-G2", slotId: "PM" });
    // AM 早已结束，无法再取
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(2), serviceCode: "JZZ-QZ-02", date: DATE, windowId: "W-G1", slotId: "AM" }),
      (e) => e.code === "SLOT_ENDED"
    );
    // 傍晚：PM 17:00 已结束，收号
    clock.set("2026-10-08T17:30:00");
    const res = await app.service.sweepNoShow({ date: DATE });
    assert.ok(res.swept >= 1);
    const after = await app.service.ticket(t1.ticketId);
    assert.equal(after.status, "no-show");
    const row = app.service.overview(DATE).slots.find((s) => s.windowId === "W-G2" && s.slotId === "PM");
    assert.equal(row.used, 0);
    assert.equal(row.noShow, 1);
    // 爽约后释放预约关系，允许再次预约
    const again = await app.service.book({ applicantRef: ref(1), serviceCode: "SC-DJ-04", date: "2026-10-09", windowId: "W-G2", slotId: "PM" });
    assert.equal(again.status, "queued");
  } finally {
    await app.cleanup();
  }
});

test("正常叫号办结核销号源", async () => {
  const app = await makeApp();
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE, windowId: "W-G1", slotId: "AM" });
    const served = await app.service.markServed({ ticketId: t.ticketId });
    assert.equal(served.status, "served");
    const row = app.service.overview(DATE).slots.find((s) => s.windowId === "W-G1" && s.slotId === "AM");
    assert.equal(row.used, 0);
    assert.equal(row.served, 1);
    await assert.rejects(() => app.service.cancel({ ticketId: t.ticketId }), (e) => e.code === "TICKET_NOT_CANCELLABLE");
  } finally {
    await app.cleanup();
  }
});

test("跨日夜间窗：开班日 21:00 可取，跨过零点后归属开班日并在 01:30 结束", async () => {
  const clock = fakeClock("2026-10-08T20:00:00");
  const app = await makeApp(clock.now);
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "GA-HZ-03", date: DATE, windowId: "W-N1", slotId: "NIGHT" });
    assert.match(t.timeRange, /跨日/);

    clock.set("2026-10-09T01:00:00");
    // 仍在 01:30 结束前：同一办事人不能重复取号（号源仍占用、重复预约拦截仍生效）
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(1), serviceCode: "GA-HZ-03", date: DATE, windowId: "W-N1", slotId: "NIGHT" }),
      (e) => e.code === "DUPLICATE_BOOKING"
    );

    clock.set("2026-10-09T02:00:00");
    const res = await app.service.sweepNoShow({ date: DATE });
    assert.equal(res.swept, 1);
    const after = await app.service.ticket(t.ticketId);
    assert.equal(after.status, "no-show");
  } finally {
    await app.cleanup();
  }
});

test("进程重启后排队顺序、取消状态与缩容容量完全一致", async () => {
  const dirApp = await makeApp();
  const dir = dirApp.dir;
  try {
    const tickets = [];
    for (let i = 1; i <= 5; i++) {
      tickets.push(
        await dirApp.service.book({
          applicantRef: ref(i),
          serviceCode: "JZZ-QZ-02",
          date: DATE,
          windowId: "W-G1",
          slotId: "AM",
          priority: i === 2 ? { accessibility: true } : {},
        })
      );
    }
    await dirApp.service.cancel({ ticketId: tickets[2].ticketId, reason: "重复预约退号" });
    await dirApp.service.shrinkCapacity({ date: DATE, windowId: "W-G1", slotId: "AM", to: 3, reason: "临时缩容" });
    const before = dirApp.service.queue(DATE, "W-G1", "AM");
    const beforeOrder = before.queued.map((t) => t.number);
    // 容量 3、在排 4：挤出队尾第 5 号；第 2 号是优先号受保护
    assert.equal(before.queued.length, 3);
    assert.equal(before.displaced.length, 1);
    assert.equal(before.displaced[0].ticketId, tickets[4].ticketId);
    await dirApp.store.close();

    // 模拟进程重启：同一状态目录重新构建
    const restarted = await buildApp({ root, stateDir: dir });
    const after = restarted.service.queue(DATE, "W-G1", "AM");
    assert.deepEqual(after.queued.map((t) => t.number), beforeOrder, "排队顺序必须一致");
    assert.equal(after.displaced[0].ticketId, tickets[4].ticketId);
    const row = restarted.service.overview(DATE).slots.find((s) => s.windowId === "W-G1" && s.slotId === "AM");
    assert.equal(row.capacity, 3);
    assert.equal(row.cancelled, 1);
    const cancelled = await restarted.service.ticket(tickets[2].ticketId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "重复预约退号");
    await restarted.store.close();
  } finally {
    await dirApp.cleanup();
  }
});

test("重启后重放任意票据可逐笔解释占用与释放", async () => {
  const app = await makeApp();
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "SC-DJ-04", date: DATE, windowId: "W-G2", slotId: "PM" });
    await app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 0, reason: "停办" });
    await app.service.reschedule({ ticketId: t.ticketId, to: { date: "2026-10-09", windowId: "W-G2", slotId: "PM" } });
    const replay = await app.service.replayTicket(t.ticketId);
    assert.equal(replay.trace.length, 3);
    assert.match(replay.trace[0].explanation, /占用 1 个号源/);
    assert.match(replay.trace[1].explanation, /缩容挤出/);
    assert.match(replay.trace[2].explanation, /释放原号源/);
  } finally {
    await app.cleanup();
  }
});
