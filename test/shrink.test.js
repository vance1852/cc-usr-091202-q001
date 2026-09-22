import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, ref } from "./helpers.js";

const DATE = "2026-10-08";

async function fill(app, serviceCode, windowId, slotId, n, { priorityFrom = 0 } = {}) {
  const tickets = [];
  for (let i = 1; i <= n; i++) {
    const priority = i > priorityFrom ? { elderlyProxy: true } : {};
    tickets.push(
      await app.service.book({ applicantRef: ref(i), serviceCode, date: DATE, windowId, slotId, priority })
    );
  }
  return tickets;
}

test("缩容从队尾挤压，优先标记号受到保护", async () => {
  const app = await makeApp();
  try {
    // W-G2 PM 容量 10，事项 SC-DJ-04：前 7 个普通号，后 3 个优先号
    const tickets = await fill(app, "SC-DJ-04", "W-G2", "PM", 10, { priorityFrom: 7 });
    const res = await app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 8, reason: "设备检修" });

    assert.equal(res.slot.capacity, 8);
    assert.equal(res.slot.used, 8);
    assert.equal(res.displaced.length, 2);
    // 被挤出的应是普通号队尾（第 7、6 号），优先号 8/9/10 保留
    const victimIds = new Set(res.displaced.map((t) => t.ticketId));
    assert.ok(victimIds.has(tickets[6].ticketId));
    assert.ok(victimIds.has(tickets[5].ticketId));
    for (let i = 7; i < 10; i++) assert.ok(!victimIds.has(tickets[i].ticketId), "优先号不应被挤出");

    const q = app.service.queue(DATE, "W-G2", "PM");
    assert.equal(q.queued.length, 8);
    assert.equal(q.displaced.length, 2);
  } finally {
    await app.cleanup();
  }
});

test("普通号不够挤时才动优先号，且优先号同样按队尾顺序", async () => {
  const app = await makeApp();
  try {
    const tickets = await fill(app, "SC-DJ-04", "W-G2", "PM", 10, { priorityFrom: 3 });
    const res = await app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 5 });
    const victims = new Set(res.displaced.map((t) => t.ticketId));
    // 普通号 1-3 全部挤出，再挤优先号队尾 10、9
    for (let i = 0; i < 3; i++) assert.ok(victims.has(tickets[i].ticketId));
    assert.ok(victims.has(tickets[9].ticketId));
    assert.ok(victims.has(tickets[8].ticketId));
    assert.ok(!victims.has(tickets[7].ticketId));
  } finally {
    await app.cleanup();
  }
});

test("缩容到 0 即临时停办；被挤票可改签或退号，容量恢复后需手动改签", async () => {
  const app = await makeApp();
  try {
    const [t1] = await fill(app, "SC-DJ-04", "W-G2", "PM", 1);
    const res = await app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 0, reason: "临时停办" });
    assert.equal(res.slot.capacity, 0);
    assert.equal(res.slot.suspended, true);

    const displaced = await app.service.ticket(t1.ticketId);
    assert.equal(displaced.status, "displaced");

    // 改签至次日
    const rs = await app.service.reschedule({
      ticketId: t1.ticketId,
      to: { date: "2026-10-09", windowId: "W-G2", slotId: "PM" },
    });
    assert.equal(rs.status, "queued");
    assert.equal(rs.date, "2026-10-09");

    const ov = app.service.overview(DATE);
    const row = ov.slots.find((s) => s.windowId === "W-G2" && s.slotId === "PM");
    assert.equal(row.used, 0, "停办时段无在排号");
  } finally {
    await app.cleanup();
  }
});

test("被挤票退号后号源释放且可追溯原因", async () => {
  const app = await makeApp();
  try {
    const [, t2] = await fill(app, "SC-DJ-04", "W-G2", "PM", 2);
    const res = await app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 1 });
    assert.equal(res.displaced[0].ticketId, t2.ticketId);
    const c = await app.service.cancel({ ticketId: t2.ticketId, reason: "申请人无法改期" });
    assert.equal(c.status, "cancelled");
    assert.equal(c.cancelReason, "申请人无法改期");
    const detail = await app.service.replayTicket(t2.ticketId);
    const types = detail.trace.map((x) => x.type);
    assert.deepEqual(types, ["TicketIssued", "TicketDisplaced", "TicketCancelled"]);
    assert.match(detail.trace[1].explanation, /缩容挤出/);
  } finally {
    await app.cleanup();
  }
});

test("缩容不能超过基准容量，恢复不能反向", async () => {
  const app = await makeApp();
  try {
    await assert.rejects(
      () => app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 11 }),
      (e) => e.code === "INVALID_CAPACITY"
    );
    await assert.rejects(
      () => app.service.restoreCapacity({ date: DATE, windowId: "W-G2", slotId: "PM" }),
      (e) => e.code === "INVALID_RESTORE"
    );
    await app.service.shrinkCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 6 });
    const r = await app.service.restoreCapacity({ date: DATE, windowId: "W-G2", slotId: "PM", to: 9 });
    assert.equal(r.slot.capacity, 9);
  } finally {
    await app.cleanup();
  }
});

test("已取号无法直接改签重复占用；改签后释放原时段并占用新时段", async () => {
  const app = await makeApp();
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE });
    assert.equal(t.windowId, "W-G1");
    const moved = await app.service.reschedule({
      ticketId: t.ticketId,
      to: { date: DATE, windowId: "W-G2", slotId: "PM" },
    });
    assert.equal(moved.windowId, "W-G2");
    const oldQ = app.service.queue(DATE, "W-G1", "AM");
    assert.equal(oldQ.queued.length, 0);
    const newQ = app.service.queue(DATE, "W-G2", "PM");
    assert.equal(newQ.queued.length, 1);
    // 跨日改签后，原日期不再存在该办事人的有效预约，可以重新取号
    await app.service.reschedule({
      ticketId: t.ticketId,
      to: { date: "2026-10-09", windowId: "W-G2", slotId: "PM" },
    });
    const again = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE, windowId: "W-G1", slotId: "AM" });
    assert.equal(again.status, "queued");
    assert.equal(again.date, DATE);
  } finally {
    app.cleanup && (await app.cleanup());
  }
});
