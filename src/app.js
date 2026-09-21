// 应用引导：装载静态资料 → 打开/校验事件日志 → 重放恢复内存状态 → 组装服务。
// 重启后排队顺序、取消状态、剩余容量全部来自事件重放，不另存快照状态。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventLog } from "./store/event-log.js";
import { Catalog } from "./domain/catalog.js";
import { HolidayCalendar } from "./domain/calendar.js";
import { BookingState, replay } from "./domain/state.js";
import { BookingService } from "./domain/booking-service.js";
import { QueryService } from "./domain/query-service.js";
import { loadOrCreateHmacKey } from "./security/privacy.js";

export async function createApp({ dataDir = resolve("data"), stateDir = resolve(".state"), clock = () => Date.now() } = {}) {
  const [catalogData, shiftsData, holidayData] = await Promise.all([
    readFile(resolve(dataDir, "catalog.json"), "utf8").then(JSON.parse),
    readFile(resolve(dataDir, "shifts.json"), "utf8").then(JSON.parse),
    readFile(resolve(dataDir, "holidays.json"), "utf8").then(JSON.parse),
  ]);

  const catalog = new Catalog(catalogData, shiftsData);
  const calendar = new HolidayCalendar(holidayData);
  const hmacKey = loadOrCreateHmacKey(resolve(stateDir, "hmac.key"));

  const log = new EventLog(resolve(stateDir, "events.log")).open();
  let events;
  try {
    events = log.readAll();
  } catch (err) {
    log.close();
    throw err;
  }
  const state = replay(events, new BookingState());

  const service = new BookingService({ log, state, catalog, calendar, hmacKey, clock });
  const queries = new QueryService({ catalog, calendar, state, clock });

  return {
    catalog,
    calendar,
    log,
    state,
    service,
    queries,
    eventCount: events.length,
    close() {
      log.close();
    },
  };
}
