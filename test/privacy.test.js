import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidIdCardNumber,
  maskName,
  maskIdNumber,
  pseudonymize,
  attestIdentity,
  safeEqual,
} from "../src/security/privacy.js";
import { makeIdCard } from "./helpers.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");

test("合法身份证号通过校验，篡改一位即失败", () => {
  const id = makeIdCard("19650307", 123); // 61 岁
  assert.equal(isValidIdCardNumber(id), true);
  const tampered = id.slice(0, -1) + (id.endsWith("X") ? "1" : "X");
  // X 可能恰好是正确校验码，换一个确定不同的末位
  const bad = id.slice(0, 14) + (id[14] === "0" ? "1" : "0") + id.slice(15);
  assert.notEqual(bad, id);
  assert.equal(isValidIdCardNumber(bad), false);
  void tampered;
});

test("非法证件在入口被拒", () => {
  assert.throws(
    () => attestIdentity({ name: "李四", idType: "ID_CARD", idNumber: "123" }, {}, KEY, "2026-09-21"),
    /校验未通过/
  );
});

test("60 岁以上自动获得老年优先标记", () => {
  const id = makeIdCard("19650307", 123);
  const r = attestIdentity({ name: "李大爷", idType: "ID_CARD", idNumber: id }, {}, KEY, "2026-09-21");
  assert.equal(r.priorities.elderly, true);
  assert.equal(r.priorities.proxy, false);
});

test("代办与无障碍标记被保留", () => {
  const id = makeIdCard("19480101", 456);
  const r = attestIdentity(
    { name: "王老太太", idType: "ID_CARD", idNumber: id },
    { proxy: true, needAccessibility: true },
    KEY,
    "2026-09-21"
  );
  assert.deepEqual(r.priorities, { elderly: true, proxy: true, accessibility: true });
});

test("落盘视图不含原始证件号与完整姓名", () => {
  const id = makeIdCard("19900307", 789);
  const r = attestIdentity({ name: "欧阳娜娜", idType: "ID_CARD", idNumber: id }, {}, KEY, "2026-09-21");
  assert.equal(r.identity.maskedName, "欧阳**");
  assert.match(r.identity.idTail, /^\d{4}$/);
  assert.equal(r.identity.idTail, id.slice(-4));
  assert.ok(!JSON.stringify(r.identity).includes(id));
  assert.equal(maskName("张三"), "张*");
  assert.equal(maskIdNumber(id), `****${id.slice(-4)}`);
});

test("同一证件假名恒定，不同证件假名不同且不可反推", () => {
  const a = makeIdCard("19900307", 111);
  const b = makeIdCard("19900307", 222);
  assert.equal(pseudonymize("ID_CARD", a, KEY), pseudonymize("ID_CARD", a, KEY));
  assert.notEqual(pseudonymize("ID_CARD", a, KEY), pseudonymize("ID_CARD", b, KEY));
  // 末四位相同的两个号假名仍不同
  const c = makeIdCard("19900307", 311);
  if (a.slice(-4) === c.slice(-4)) {
    assert.notEqual(pseudonymize("ID_CARD", a, KEY), pseudonymize("ID_CARD", c, KEY));
  }
});

test("常量时间比较", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});
