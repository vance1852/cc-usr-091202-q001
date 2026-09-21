import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { newApp, reopenApp, makeIdCard, SHIFTS } from "./helpers.js";
import { BookingError } from "../src/domain/booking-service.js";
import { TicketStatus } from "../src/domain/state.js";
import { replayTicket } from "../src/domain/audit.js";

let counter = 0;
function issueInput({
  seq = 1,
  birth = "19900307",
  name = "张三",
  shiftId = SHIFTS.win1Morning,
  itemCode = "JZZ_QZ",
  flags = {},
  materials = ["身份证", "居住证"],
  idem = true,
} = {}) {
  return {
    shiftId,
    itemCode,
    identity: { name, idType: "ID_CARD", idNumber: makeIdCard(birth, seq) },
    flags,
    materials,
    idempotencyKey: idem ? `key-${process.pid}-${counter++}` : undefined,
  };
}

async function assertRejects(p, code) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof BookingError || err.code, `应是业务错误：${err}`);
    if (code) assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
    return true;
  });
}

test("取号成功：余量减少、位置返回、响应不含原始证件号", async () => {
  const app = await newApp();
  const r = await app.service.issueTicket(issueInput({ seq: 1 }));
  assert.equal(r.remaining, 5); // 容量 6
  assert.equal(r.queuePosition, 1);
  assert.match(r.ticketId, /^T\d{4}$/);
  assert.equal(r.itemCode, "JZZ_QZ");
  assert.ok(!JSON.stringify(r).includes(makeIdCard("19900307", 1)));

  const board = app.queries.dailyBoard("2026-09-21");
  const win1 = board.find((b) => b.shiftId === SHIFTS.win1Morning);
  assert.equal(win1.used, 1);
  assert.equal(win1.remaining, 5);
  assert.equal(win1.queue[0].maskedName, "张*");
  app.close();
});

test("同一人当天同一事项重复取号被拦截（换窗口也不行）", async () => {
  const app = await newApp();
  const samePerson = { seq: 7 };
  await app.service.issueTicket(issueInput({ ...samePerson, shiftId: SHIFTS.win1Morning }));
  await assertRejects(
    app.service.issueTicket(issueInput({ ...samePerson, shiftId: SHIFTS.win2Morning })),
    "DUPLICATE_BOOKING"
  );
  // 退号后可重新取号
  const t = app.state.tickets.get([...app.state.tickets.keys()][0]);
  await app.service.cancelTicket({ ticketId: t.ticketId, reason: "行程冲突", idempotencyKey: `k-${counter++}` });
  const again = await app.service.issueTicket(issueInput({ ...samePerson, shiftId: SHIFTS.win2Morning }));
  assert.equal(again.remaining, 4);
  app.close();
});

test("同一人当天不同事项可分别取号", async () => {
  const app = await newApp();
  await app.service.issueTicket(issueInput({ seq: 9, itemCode: "JZZ_QZ", materials: ["身份证", "居住证"] }));
  const r2 = await app.service.issueTicket(
    issueInput({ seq: 9, itemCode: "SB_ZY", shiftId: SHIFTS.win1Afternoon, materials: ["身份证", "参保缴费凭证"] })
  );
  assert.ok(r2.ticketId);
  app.close();
});

test("号源满后拒绝取号，退号立即释放出一个余量", async () => {
  const app = await newApp();
  for (let i = 1; i <= 5; i++) {
    await app.service.issueTicket(issueInput({ seq: 100 + i, shiftId: SHIFTS.win2Morning }));
  }
  await assertRejects(
    app.service.issueTicket(issueInput({ seq: 200, shiftId: SHIFTS.win2Morning })),
    "SHIFT_FULL"
  );
  const firstId = app.state.queues.get(SHIFTS.win2Morning)[0];
  await app.service.cancelTicket({ ticketId: firstId, reason: "资料不齐", idempotencyKey: `k-${counter++}` });
  const late = await app.service.issueTicket(issueInput({ seq: 200, shiftId: SHIFTS.win2Morning }));
  assert.equal(late.remaining, 0);
  app.close();
});

test("幂等：网络重试同键同体返回同一笔号，不重复占号", async () => {
  const app = await newApp();
  const body = issueInput({ seq: 300 });
  const r1 = await app.service.issueTicket(body);
  const r2 = await app.service.issueTicket(body);
  assert.equal(r1.ticketId, r2.ticketId);
  assert.equal(r2.replayed, true);
  assert.equal(app.state.activeCount(SHIFTS.win1Morning), 1);
  app.close();
});

test("幂等：同键不同请求体被拒绝", async () => {
  const app = await newApp();
  const body = issueInput({ seq: 301 });
  await app.service.issueTicket(body);
  await assertRejects(
    app.service.issueTicket({ ...body, itemCode: "SB_ZY", materials: ["身份证", "参保缴费凭证"] }),
    "IDEMPOTENCY_CONFLICT"
  );
  app.close();
});

test("幂等：同一键并发双击只产生一笔取号", async () => {
  const app = await newApp();
  const body = issueInput({ seq: 400 });
  const results = await Promise.all(Array.from({ length: 5 }, () => app.service.issueTicket(body)));
  const ids = new Set(results.map((r) => r.ticketId));
  assert.equal(ids.size, 1);
  assert.equal(app.state.activeCount(SHIFTS.win1Morning), 1);
  app.close();
});

test("并发不同请求在容量边界上不多卖号", async () => {
  const app = await newApp(); // 一号窗早班容量 6
  const results = await Promise.allSettled(
    Array.from({ length: 9 }, (_, i) => app.service.issueTicket(issueInput({ seq: 500 + i })))
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 6);
  assert.equal(rejected.length, 3);
  assert.equal(rejected[0].reason.code, "SHIFT_FULL");
  assert.equal(app.state.activeCount(SHIFTS.win1Morning), 6);
  app.close();
});

test("优先标记决定入队位置：老年、无障碍优先但标记仍随号保留", async () => {
  const app = await newApp();
  await app.service.issueTicket(issueInput({ seq: 11, name: "赵甲" }));
  await app.service.issueTicket(issueInput({ seq: 12, name: "钱乙" }));
  await app.service.issueTicket(
    issueInput({ seq: 13, birth: "19620101", name: "孙大爷", flags: { proxy: true } })
  );
  const q = app.queries.shiftView(SHIFTS.win1Morning).queue;
  assert.equal(q[0].maskedName, "孙**");
  assert.deepEqual(q[0].priorities, { elderly: true, proxy: true, accessibility: false });
  assert.equal(q[1].maskedName, "赵*");
  assert.equal(q[2].maskedName, "钱*");
  app.close();
});

test("无障碍需求在无设施窗口被拦截，确认或改挂无障碍窗口可办", async () => {
  const app = await newApp();
  await assertRejects(
    app.service.issueTicket(issueInput({ seq: 21, shiftId: SHIFTS.win2Morning, flags: { needAccessibility: true } })),
    "ACCESSIBLE_WINDOW_REQUIRED"
  );
  const ok1 = await app.service.issueTicket(
    issueInput({ seq: 21, shiftId: SHIFTS.win1Morning, flags: { needAccessibility: true } })
  );
  assert.ok(ok1.ticketId);
  app.close();
});

test("材料不齐会记录缺失材料但不阻止取号", async () => {
  const app = await newApp();
  const r = await app.service.issueTicket(issueInput({ seq: 31, materials: ["身份证"] }));
  assert.deepEqual(r.missingMaterials, ["居住证"]);
  app.close();
});

test("改签：从早班迁到下午班并重新按优先级入队", async () => {
  const app = await newApp();
  const r = await app.service.issueTicket(issueInput({ seq: 41, shiftId: SHIFTS.win1Morning }));
  const moved = await app.service.rescheduleTicket({
    ticketId: r.ticketId,
    toShiftId: SHIFTS.win1Afternoon,
    reason: "早班赶不到",
    idempotencyKey: `k-${counter++}`,
  });
  assert.equal(moved.toShiftId, SHIFTS.win1Afternoon);
  assert.equal(app.state.activeCount(SHIFTS.win1Morning), 0);
  assert.equal(app.state.activeCount(SHIFTS.win1Afternoon), 1);
  assert.equal(moved.queuePosition, 1);
  app.close();
});

test("临时停办：在场号全部挤出形成处置单，退号/改签必须关联处置单", async () => {
  const app = await newApp();
  const r1 = await app.service.issueTicket(issueInput({ seq: 51 }));
  const r2 = await app.service.issueTicket(issueInput({ seq: 52 }));
  const res = await app.service.suspendShift({ shiftId: SHIFTS.win1Morning, reason: "窗口设备故障" });
  assert.ok(res.displacementId);
  assert.equal(res.displaced.length, 2);

  const view = app.queries.shiftView(SHIFTS.win1Morning);
  assert.equal(view.suspended, true);
  assert.equal(view.bookable, false);
  assert.equal(view.remaining, 0);

  // 停办期间不能取新号
  await assertRejects(app.service.issueTicket(issueInput({ seq: 53 })), "SHIFT_SUSPENDED");

  // 挤出号不带处置单不能退
  await assertRejects(
    app.service.cancelTicket({ ticketId: r1.ticketId, reason: "停办退号", idempotencyKey: `k-${counter++}` }),
    "DISPLACEMENT_LINK_REQUIRED"
  );
  // 带处置单退号成功，链路落事件
  await app.service.cancelTicket({
    ticketId: r1.ticketId,
    reason: "停办退号",
    displacementId: res.displacementId,
    idempotencyKey: `k-${counter++}`,
  });
  // 另一笔挤出改签
  const moved = await app.service.rescheduleTicket({
    ticketId: r2.ticketId,
    toShiftId: SHIFTS.win1Afternoon,
    reason: "停办改签",
    displacementId: res.displacementId,
    idempotencyKey: `k-${counter++}`,
  });
  assert.equal(moved.toShiftId, SHIFTS.win1Afternoon);

  const pending = app.queries.pendingDisplacements();
  assert.equal(pending.length, 0);
  app.close();
});

test("缩容：超出新容量的队尾号被挤出并可逐一改签", async () => {
  const app = await newApp();
  const issued = [];
  for (let i = 0; i < 4; i++) {
    issued.push(await app.service.issueTicket(issueInput({ seq: 60 + i })));
  }
  const res = await app.service.changeCapacity({
    shiftId: SHIFTS.win1Morning,
    newCapacity: 2,
    reason: "临时合并窗口",
  });
  assert.equal(res.displaced.length, 2);
  const displacedIds = res.displaced.map((d) => d.ticketId);
  assert.deepEqual(displacedIds, [issued[2].ticketId, issued[3].ticketId]);
  assert.equal(app.state.activeCount(SHIFTS.win1Morning), 2);

  for (const id of displacedIds) {
    await app.service.rescheduleTicket({
      ticketId: id,
      toShiftId: SHIFTS.win1Afternoon,
      reason: "缩容改签",
      displacementId: res.displacementId,
      idempotencyKey: `k-${counter++}`,
    });
  }
  assert.equal(app.state.activeCount(SHIFTS.win1Afternoon), 2);
  app.close();
});

test("爽约扫描：场次结束后在队号被标记并释放；进行中不动", async () => {
  const app = await newApp("2026-09-21T12:30:00+08:00");
  const r = await app.service.issueTicket(issueInput({ seq: 70, shiftId: SHIFTS.win2Morning }));
  let sweep = await app.service.sweepNoShows();
  assert.deepEqual(sweep.marked, [r.ticketId]);
  assert.equal(app.state.tickets.get(r.ticketId).status, TicketStatus.NOSHOW);
  assert.equal(app.state.activeCount(SHIFTS.win2Morning), 0);
  // 再次扫描不会重复处理
  sweep = await app.service.sweepNoShows();
  assert.deepEqual(sweep.marked, []);
  app.close();
});

test("跨零点夜班：凌晨 00:30 仍算在场，01:00 后才爽约", async () => {
  let app = await newApp("2026-09-21T20:00:00+08:00");
  const r = await app.service.issueTicket(issueInput({ seq: 80, shiftId: SHIFTS.win1Night }));
  app.close();

  app = await reopenApp(app, "2026-09-22T00:30:00+08:00");
  let sweep = await app.service.sweepNoShows();
  assert.deepEqual(sweep.marked, []);
  app.close();

  app = await reopenApp(app, "2026-09-22T01:30:00+08:00");
  sweep = await app.service.sweepNoShows();
  assert.deepEqual(sweep.marked, [r.ticketId]);
  app.close();
});

test("法定节假日班次不可取号；调休上班日可办", async () => {
  const app = await newApp();
  await assertRejects(
    app.service.issueTicket(
      issueInput({ seq: 90, shiftId: SHIFTS.nationalDay, itemCode: "GJJ_TQ", materials: ["身份证", "提取申请表", "购房或租房证明"] })
    ),
    "SHIFT_HOLIDAY_CLOSED"
  );
  const r = await app.service.issueTicket(
    issueInput({ seq: 91, shiftId: SHIFTS.makeupWorkday, materials: ["身份证", "居住证"] })
  );
  assert.ok(r.ticketId);
  app.close();
});

test("人工调队不能夹带增删：集合不一致的重排被整体拒绝", async () => {
  const app = await newApp();
  const r1 = await app.service.issueTicket(issueInput({ seq: 101 }));
  await app.service.issueTicket(issueInput({ seq: 102 }));
  const eventsBefore = app.log.seq;
  await assertRejects(
    app.service.reorderQueue({ shiftId: SHIFTS.win1Morning, ticketIds: [r1.ticketId, "T9999"] }),
    "QUEUE_REORDER_INVALID"
  );
  assert.equal(app.log.seq, eventsBefore, "被拒绝的调队不应产生事件");

  // 夹带重复号同样被拒
  await assertRejects(
    app.service.reorderQueue({ shiftId: SHIFTS.win1Morning, ticketIds: [r1.ticketId, r1.ticketId] }),
    "QUEUE_REORDER_INVALID"
  );
  app.close();
});

test("重启恢复：队列顺序、取消状态、容量与幂等记录与中断前一致", async () => {
  let app = await newApp("2026-09-21T08:00:00+08:00");
  const bodyA = issueInput({ seq: 201 });
  const bodyB = issueInput({ seq: 202 });
  const bodyElder = issueInput({ seq: 203, birth: "19600101", name: "李老伯" });
  const a = await app.service.issueTicket(bodyA);
  const b = await app.service.issueTicket(bodyB);
  const elder = await app.service.issueTicket(bodyElder);
  await app.service.cancelTicket({ ticketId: b.ticketId, reason: "临时有事", idempotencyKey: `k-${counter++}` });
  await app.service.changeCapacity({ shiftId: SHIFTS.win1Morning, newCapacity: 5, reason: "窗口减位" });
  const events = app.log.seq;
  app.close();

  app = await reopenApp(app);
  assert.equal(app.log.seq, events);
  const q = app.state.queues.get(SHIFTS.win1Morning);
  assert.deepEqual(q, [elder.ticketId, a.ticketId]); // 老年优先在前，退号者不在队
  assert.equal(app.state.tickets.get(b.ticketId).status, TicketStatus.CANCELLED);
  assert.equal(app.state.runtime.get(SHIFTS.win1Morning).capacity, 5);
  assert.equal(app.queries.shiftView(SHIFTS.win1Morning).remaining, 3); // 5-2

  // 幂等记录随事件恢复：原请求（含原键）重试返回同一笔号，不重复占号
  const retry = await app.service.issueTicket(bodyA);
  assert.equal(retry.ticketId, a.ticketId);
  assert.equal(retry.replayed, true);
  assert.equal(app.state.activeCount(SHIFTS.win1Morning), 2);

  // 不带键的重复取号仍被业务规则拦截
  await assertRejects(
    app.service.issueTicket({ ...bodyA, idempotencyKey: undefined }),
    "DUPLICATE_BOOKING"
  );
  app.close();
});

test("单笔重放：完整还原占用→挤出→改签的号源轨迹", async () => {
  const app = await newApp();
  const r = await app.service.issueTicket(issueInput({ seq: 301 }));
  const susp = await app.service.suspendShift({ shiftId: SHIFTS.win1Morning, reason: "系统检修" });
  await app.service.rescheduleTicket({
    ticketId: r.ticketId,
    toShiftId: SHIFTS.win1Afternoon,
    reason: "停办改签",
    displacementId: susp.displacementId,
    idempotencyKey: `k-${counter++}`,
  });
  const report = replayTicket(app.log.readAll(), r.ticketId);
  assert.equal(report.currentlyHoldsCapacity, true);
  assert.equal(report.currentShiftId, SHIFTS.win1Afternoon);
  assert.deepEqual(report.timeline.map((t) => t.type), [
    "TicketIssued",
    "TicketDisplaced",
    "TicketRescheduled",
  ]);
  assert.match(report.timeline[1].effect, /处置单 D0001/);
  // 重放数据里没有原始证件号
  assert.ok(!JSON.stringify(report).includes(makeIdCard("19900307", 301)));
  app.close();
});

test("事件日志被追加脏数据后启动拒绝并报错", async () => {
  const app = await newApp();
  await app.service.issueTicket(issueInput({ seq: 401 }));
  appendFileSync(join(app.stateDir, "events.log"), "{这不是合法JSON\n");
  app.close();
  await assert.rejects(reopenApp(app), /合法 JSON/);
});
