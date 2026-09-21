import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(here, "..", "data");

export function fixedClock(iso) {
  const ms = Date.parse(iso);
  return () => ms;
}

/** 生成带合法校验码的 18 位身份证号（测试用，非真实号码）。 */
export function makeIdCard(birthYYYYMMDD = "19900307", seq = 123) {
  const prefix = `110101${birthYYYYMMDD}${String(seq).padStart(3, "0")}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(prefix[i]) * weights[i];
  return prefix + checkCodes[sum % 11];
}

export function person({ birth = "19900307", seq = 1, name = "张三", flags = {} } = {}) {
  return {
    identity: { name, idType: "ID_CARD", idNumber: makeIdCard(birth, seq) },
    flags,
  };
}

export async function newApp(clockIso = "2026-09-21T08:00:00+08:00") {
  const stateDir = mkdtempSync(join(tmpdir(), "yuyue-"));
  const app = await createApp({ dataDir: DATA_DIR, stateDir, clock: fixedClock(clockIso) });
  app.stateDir = stateDir;
  return app;
}

export async function reopenApp(app, clockIso = "2026-09-21T08:00:00+08:00") {
  const { stateDir } = app;
  app.close();
  const reopened = await createApp({ dataDir: DATA_DIR, stateDir, clock: fixedClock(clockIso) });
  reopened.stateDir = stateDir;
  return reopened;
}

export const SHIFTS = {
  win1Morning: "2026-09-21#综合受理一号窗#MORNING",
  win1Afternoon: "2026-09-21#综合受理一号窗#AFTERNOON",
  win1Night: "2026-09-21#综合受理一号窗#NIGHT",
  win2Morning: "2026-09-21#综合受理二号窗#MORNING",
  win2Afternoon: "2026-09-21#综合受理二号窗#AFTERNOON",
  fund: "2026-09-21#公积金专窗#ALLDAY",
  nextDay: "2026-09-22#综合受理一号窗#MORNING",
  nationalDay: "2026-10-01#公积金专窗#ALLDAY",
  makeupWorkday: "2026-10-10#综合受理一号窗#ALLDAY",
};
