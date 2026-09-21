import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/server.js";
import { newApp, makeIdCard, SHIFTS } from "./helpers.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function call(port, method, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("HTTP 全链路：取号(含幂等头)→看板→停办→退号→重放→校验", async () => {
  const app = await newApp();
  const server = createHttpServer(app);
  const port = await listen(server);
  try {
    const payload = {
      shiftId: SHIFTS.win1Morning,
      itemCode: "JZZ_QZ",
      identity: { name: "张三", idType: "ID_CARD", idNumber: makeIdCard("19900307", 1) },
      flags: {},
      materials: ["身份证", "居住证"],
    };

    // 第一次取号
    const r1 = await call(port, "POST", "/tickets", payload, { "idempotency-key": "click-001" });
    assert.equal(r1.status, 200);
    const ticketId = r1.json.ticket.ticketId;

    // 网络重试（同键）：同一笔号
    const r2 = await call(port, "POST", "/tickets", payload, { "idempotency-key": "click-001" });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.ticket.ticketId, ticketId);
    assert.equal(r2.json.ticket.replayed, true);

    // 看板余量 5/6
    const board = await call(port, "GET", "/board?date=2026-09-21");
    const win1 = board.json.windows.find((w) => w.shiftId === SHIFTS.win1Morning);
    assert.equal(win1.used, 1);
    assert.equal(win1.remaining, 5);

    // 响应中绝不出现原始证件号
    assert.ok(!JSON.stringify(board).includes(makeIdCard("19900307", 1)));

    // 国庆节班次看板显示不可订
    const holiday = await call(port, "GET", `/shifts/${encodeURIComponent(SHIFTS.nationalDay)}`);
    assert.equal(holiday.json.shift.bookable, false);
    assert.match(holiday.json.shift.calendarStatus.reason, /国庆/);

    // 单笔重放
    const replay = await call(port, "GET", `/tickets/${ticketId}/replay`);
    assert.equal(replay.json.replay.timeline.length, 1);
    assert.match(replay.json.replay.timeline[0].effect, /占用号源/);

    // 日志校验
    const verify = await call(port, "GET", "/audit/verify");
    assert.equal(verify.json.ok, true);
    assert.equal(verify.json.events, 1);

    // 停办后挤出，再关联处置单退号
    const susp = await call(port, "POST", `/shifts/${encodeURIComponent(SHIFTS.win1Morning)}/suspend`, { reason: "应急演练停办" });
    const displacementId = susp.json.displacementId;
    const cancel = await call(port, "POST", `/tickets/${ticketId}/cancel`, { reason: "停办退号", displacementId }, { "idempotency-key": "cancel-001" });
    assert.equal(cancel.status, 200);

    // 退号重试同键也不报错、不产生第二事件
    const cancelRetry = await call(port, "POST", `/tickets/${ticketId}/cancel`, { reason: "停办退号", displacementId }, { "idempotency-key": "cancel-001" });
    assert.equal(cancelRetry.status, 200);
    const verify2 = await call(port, "GET", "/audit/verify");
    assert.equal(verify2.json.events, 4); // 取号 + 停办 + 挤出 + 退号
  } finally {
    server.close();
    app.close();
  }
});

test("HTTP 非法请求返回业务错误码", async () => {
  const app = await newApp();
  const server = createHttpServer(app);
  const port = await listen(server);
  try {
    // 节假日取号
    const r = await call(port, "POST", "/tickets", {
      shiftId: SHIFTS.nationalDay,
      itemCode: "GJJ_TQ",
      identity: { name: "李四", idType: "ID_CARD", idNumber: makeIdCard("19900307", 2) },
      materials: ["身份证", "提取申请表", "购房或租房证明"],
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "SHIFT_HOLIDAY_CLOSED");

    // 坏 JSON
    const res = await fetch(`http://127.0.0.1:${port}/tickets`, { method: "POST", body: "{坏了" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_JSON");
  } finally {
    server.close();
    app.close();
  }
});
