import { test } from "node:test";
import assert from "node:assert/strict";
import { HolidayCalendar } from "../src/domain/calendar.js";
import { parseShiftRange, weekdayOfDate } from "../src/util/time.js";

const cal = new HolidayCalendar({
  holidays: [
    { date: "2026-09-25", name: "中秋节" },
    { date: "2026-10-01", name: "国庆节" },
  ],
  makeupWorkdays: [{ date: "2026-10-10", workAs: "Monday", name: "国庆调休上班" }],
  weekendOpen: false,
});

test("普通工作日开放", () => {
  const r = cal.resolve("2026-09-22");
  assert.equal(r.open, true);
  assert.match(r.reason, /工作日/);
});

test("法定节假日即使是工作日也停办", () => {
  assert.equal(weekdayOfDate("2026-10-01"), 4); // 周四
  const r = cal.resolve("2026-10-01");
  assert.equal(r.open, false);
  assert.match(r.reason, /国庆节/);
});

test("中秋节（周五）按节假日停办", () => {
  assert.equal(cal.isOpen("2026-09-25"), false);
});

test("普通周末停办", () => {
  assert.equal(weekdayOfDate("2026-09-26"), 6); // 周六
  assert.equal(cal.isOpen("2026-09-26"), false);
  assert.equal(cal.isOpen("2026-09-27"), false);
});

test("调休上班的周末按工作日开放", () => {
  assert.equal(weekdayOfDate("2026-10-10"), 6); // 本是周六
  const r = cal.resolve("2026-10-10");
  assert.equal(r.open, true);
  assert.match(r.reason, /调休上班日/);
});

test("跨零点夜班结束时间自动顺延到次日", () => {
  const { start, end } = parseShiftRange("2026-09-21", "21:00", "01:00", true);
  assert.equal(start, Date.parse("2026-09-21T21:00:00+08:00"));
  assert.equal(end, Date.parse("2026-09-22T01:00:00+08:00"));
  assert.ok(end > start);
});

test("非跨日班次 end<=start 时也按跨夜处理（防御）", () => {
  const { end } = parseShiftRange("2026-09-21", "09:00", "09:00");
  assert.equal(end, Date.parse("2026-09-22T09:00:00+08:00"));
});
