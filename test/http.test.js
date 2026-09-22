import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { createHttpServer } from "../src/http/server.js";
import { root } from "./helpers.js";

async function startServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gov-http-"));
  const app = await buildApp({ root, stateDir: dir });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    dir,
    async stop() {
      await new Promise((r) => server.close(r));
      await app.store.close();
    },
    async rmdir() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("HTTP 端到端：取号/幂等重试/重复拦截/缩容改签/重放/重启一致", async () => {
  const srv = await startServer();
  after(async () => {
    await srv.stop();
    await srv.rmdir();
  });
  const call = (method, p, body, headers = {}) =>
    fetch(srv.base + p, {
      method,
      headers: body ? { "content-type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));

  // 开门前总览
  const ov = await call("GET", "/api/overview?date=2026-10-08");
  assert.equal(ov.status, 200);
  assert.equal(ov.json.open, true);
  const g1am = ov.json.slots.find((s) => s.windowId === "W-G1" && s.slotId === "AM");
  assert.equal(g1am.remaining, 18);

  // 国庆节关门
  const holiday = await call("GET", "/api/overview?date=2026-10-01");
  assert.equal(holiday.json.open, false);

  // 取号 + 相同 Idempotency-Key 的网络重试
  const payload = { applicantRef: "ref-citizen-0001", serviceCode: "JZZ-QZ-02", date: "2026-10-08" };
  const [r1, r2] = await Promise.all([
    call("POST", "/api/tickets", payload, { "idempotency-key": "net-retry-1" }),
    call("POST", "/api/tickets", payload, { "idempotency-key": "net-retry-1" }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.json.ticketId, r2.json.ticketId);
  assert.equal(r2.json.idempotentReplay, true);
  const ticketId = r1.json.ticketId;

  // 不带键的重复点击被业务规则拦截
  const dup = await call("POST", "/api/tickets", payload);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "DUPLICATE_BOOKING");

  // 身份字段被拒
  const leak = await call("POST", "/api/tickets", { ...payload, idCard: "110101199003071234" });
  assert.equal(leak.status, 422);

  // 缩容停办该时段（先取满若干）
  for (let i = 2; i <= 4; i++) {
    await call("POST", "/api/tickets", {
      applicantRef: `ref-citizen-000${i}`,
      serviceCode: "JZZ-QZ-02",
      date: "2026-10-08",
      windowId: "W-G1",
      slotId: "AM",
      priority: i === 3 ? { accessibility: true } : {},
    });
  }
  const shrink = await call("POST", "/api/admin/shrink", {
    date: "2026-10-08",
    windowId: "W-G1",
    slotId: "AM",
    to: 2,
    reason: "窗口设备故障",
  });
  assert.equal(shrink.status, 200);
  assert.equal(shrink.json.slot.used, 2);
  assert.equal(shrink.json.displaced.length, 2);

  // 原票被挤出后改签次日
  const mine = await call("GET", `/api/tickets/${ticketId}`);
  // ref-citizen-0001 是最早入队的普通号，不会被队尾挤压；找一个 displaced 的票改签
  const displacedId = shrink.json.displaced.find((t) => !t.priorityLabels.length).ticketId ?? shrink.json.displaced[0].ticketId;
  const rs = await call("POST", `/api/tickets/${displacedId}/reschedule`, {
    to: { date: "2026-10-09" },
    reason: "窗口故障改签",
  });
  assert.equal(rs.status, 200);
  assert.equal(rs.json.status, "queued");
  assert.equal(rs.json.date, "2026-10-09");

  // 重放该票核对来龙去脉
  const replay = await call("GET", `/api/tickets/${displacedId}/replay`);
  assert.equal(replay.json.trace.length, 3);
  assert.deepEqual(replay.json.trace.map((t) => t.type), [
    "TicketIssued",
    "TicketDisplaced",
    "TicketRescheduled",
  ]);

  // 事件流审计
  const events = await call("GET", "/api/admin/events");
  assert.ok(events.json.events.length >= 6);

  await srv.stop();

  // 重启：同一状态目录
  const app2 = await buildApp({ root, stateDir: srv.dir });
  const server2 = createHttpServer(app2);
  await new Promise((resolve) => server2.listen(0, resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    const q = await fetch(`${base2}/api/queues/2026-10-08/W-G1/AM`).then((r) => r.json());
    assert.equal(q.queued.length, 2);
    assert.equal(q.displaced.length, 1, "一人已改签、一人仍待处置");
    const ov2 = await fetch(`${base2}/api/overview?date=2026-10-08`).then((r) => r.json());
    const row = ov2.slots.find((s) => s.windowId === "W-G1" && s.slotId === "AM");
    assert.equal(row.capacity, 2);
    assert.equal(row.used, 2);
  } finally {
    await new Promise((r) => server2.close(r));
    await app2.store.close();
    await srv.rmdir();
  }
});

test("写操作鉴权：设置 STAFF_TOKEN 后无令牌返回 401", async (t) => {
  process.env.STAFF_TOKEN = "secret-token";
  t.after(() => delete process.env.STAFF_TOKEN);
  const srv = await startServer();
  t.after(async () => {
    await srv.stop();
    await srv.rmdir();
  });
  const r1 = await fetch(`${srv.base}/api/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ applicantRef: "ref-citizen-0009", serviceCode: "JZZ-QZ-02", date: "2026-10-08" }),
  });
  assert.equal(r1.status, 401);
  const r2 = await fetch(`${srv.base}/api/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
    body: JSON.stringify({ applicantRef: "ref-citizen-0009", serviceCode: "JZZ-QZ-02", date: "2026-10-08" }),
  });
  assert.equal(r2.status, 200);
});
