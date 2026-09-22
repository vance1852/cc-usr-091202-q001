import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, ref } from "./helpers.js";

const DATE = "2026-10-08";

test("正常取号占用号源并出现在队列中，余量递减", async () => {
  const app = await makeApp();
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE });
    assert.equal(t.status, "queued");
    assert.match(t.applicant, /^ref_[0-9a-f]{10}$/, "对外只暴露掩码");
    assert.ok(t.missingMaterials.length > 0, "未提交的材料应被提示");

    const ov = app.service.overview(DATE);
    const g1am = ov.slots.find((s) => s.windowId === "W-G1" && s.slotId === "AM");
    assert.equal(g1am.used, 1);
    assert.equal(g1am.remaining, 17);

    const q = app.service.queue(DATE, "W-G1", "AM");
    assert.equal(q.queued.length, 1);
    assert.equal(q.queued[0].number, t.number);
  } finally {
    await app.cleanup();
  }
});

test("不指定窗口时段时自动分流到余量最多的时段", async () => {
  const app = await makeApp();
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE });
    // 两窗上午容量 18 vs 12，应落在 W-G1 AM
    assert.equal(t.windowId, "W-G1");
    assert.equal(t.slotId, "AM");
  } finally {
    await app.cleanup();
  }
});

test("同一办事人同一事项同一日期的重复预约被拒绝", async () => {
  const app = await makeApp();
  try {
    await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE });
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE }),
      (e) => e.code === "DUPLICATE_BOOKING"
    );
  } finally {
    await app.cleanup();
  }
});

test("同一事项不同日期可以分别预约", async () => {
  const app = await makeApp();
  try {
    await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: "2026-10-08" });
    const t2 = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: "2026-10-09" });
    assert.equal(t2.status, "queued");
  } finally {
    await app.cleanup();
  }
});

test("带相同幂等键的网络重试只产生一笔取号", async () => {
  const app = await makeApp();
  try {
    const input = { applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE, idempotencyKey: "click-001" };
    const [a, b, c] = await Promise.all([
      app.service.book(input),
      app.service.book(input),
      app.service.book(input),
    ]);
    assert.equal(a.ticketId, b.ticketId);
    assert.equal(a.ticketId, c.ticketId);
    assert.equal(c.idempotentReplay, true);
    const ov = app.service.overview(DATE);
    const used = ov.slots
      .filter((s) => s.windowId === "W-G1")
      .reduce((n, s) => n + s.used, 0);
    assert.equal(used, 1, "并发重试不得超占号源");
  } finally {
    await app.cleanup();
  }
});

test("幂等键复用于不同操作时报冲突", async () => {
  const app = await makeApp();
  try {
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE, idempotencyKey: "k1" });
    await assert.rejects(
      () => app.service.cancel({ ticketId: t.ticketId, idempotencyKey: "k1" }),
      (e) => e.code === "IDEMPOTENCY_CONFLICT"
    );
  } finally {
    await app.cleanup();
  }
});

test("节假日无法取号，调休日可以取号", async () => {
  const app = await makeApp();
  try {
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: "2026-10-01" }),
      (e) => e.code === "SLOT_CLOSED_BY_POLICY"
    );
    const t = await app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: "2026-09-26" });
    assert.equal(t.status, "queued");
  } finally {
    await app.cleanup();
  }
});

test("号源满后再取号被拒绝", async () => {
  const app = await makeApp();
  try {
    // W-G2 PM 容量 10，且该时段只受理 SC-DJ-04 / JZZ-QZ-02；填满 SC-DJ-04（该事项只有 W-G2 受理）
    for (let i = 1; i <= 10; i++) {
      await app.service.book({ applicantRef: ref(i), serviceCode: "SC-DJ-04", date: DATE, windowId: "W-G2", slotId: "PM" });
    }
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(99), serviceCode: "SC-DJ-04", date: DATE, windowId: "W-G2", slotId: "PM" }),
      (e) => e.code === "SLOT_FULL"
    );
  } finally {
    await app.cleanup();
  }
});

test("拒收身份证号/姓名等直接身份字段，但保留优先标记", async () => {
  const app = await makeApp();
  try {
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE, idCard: "110101199003071234" }),
      (e) => e.code === "IDENTITY_FIELD_REJECTED"
    );
    await assert.rejects(
      () => app.service.book({ applicantRef: ref(1), serviceCode: "JZZ-QZ-02", date: DATE, note: "证件号 110101199003071234" }),
      (e) => e.code === "IDENTITY_VALUE_REJECTED"
    );
    const t = await app.service.book({
      applicantRef: ref(2),
      serviceCode: "JZZ-QZ-02",
      date: DATE,
      priority: { elderlyProxy: true, accessibility: true, diagnosis: "轮椅" },
      materials: ["身份证", "居住证", "住所证明"],
    });
    assert.deepEqual(t.priority, { elderlyProxy: true, accessibility: true });
    assert.deepEqual(t.priorityLabels, ["老年人代办", "无障碍服务"]);
    assert.deepEqual(t.missingMaterials, []);
  } finally {
    await app.cleanup();
  }
});
