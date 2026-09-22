import { test } from "node:test";
import assert from "node:assert/strict";
import { Calendar } from "../src/domain/calendar.js";
import { anchorEndDate } from "../src/util/time.js";

const cal = new Calendar({
  holidays: [{ name: "国庆节、中秋节", from: "2026-10-01", to: "2026-10-07" }],
  makeupWorkdays: ["2026-09-26", "2026-10-10"],
});

test("法定节假日整天不开放", () => {
  assert.equal(cal.isOpen("2026-10-01"), false);
  assert.equal(cal.isOpen("2026-10-07"), false);
  assert.match(cal.inspect("2026-10-02").reason, /法定节假日/);
});

test("节假日后第一个工作日恢复开放", () => {
  assert.equal(cal.isOpen("2026-10-08"), true);
});

test("调休上班的周末按有效政策开放", () => {
  // 2026-09-26 是周六
  assert.equal(new Date("2026-09-26T00:00:00").getDay(), 6);
  assert.equal(cal.isOpen("2026-09-26"), true);
  assert.match(cal.inspect("2026-09-26").reason, /调休/);
  // 普通周日不开放
  assert.equal(cal.isOpen("2026-09-27"), false);
});

test("非法日期被拒绝", () => {
  assert.equal(cal.inspect("2026-02-30").open, false);
  assert.equal(cal.inspect("not-a-date").open, false);
});

test("跨日时段号源归属开班当日，结束落在次日", () => {
  const slot = { start: "21:00", end: "01:30", crossDay: true };
  assert.equal(anchorEndDate("2026-09-21", slot), "2026-09-22");
  const normal = { start: "09:00", end: "12:00" };
  assert.equal(anchorEndDate("2026-09-21", normal), "2026-09-21");
});
