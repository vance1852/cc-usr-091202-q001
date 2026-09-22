import { readFile } from "node:fs/promises";
import path from "node:path";
import { Catalog } from "./domain/catalog.js";
import { Calendar } from "./domain/calendar.js";
import { EventStore } from "./store/event-store.js";
import { ReservationService } from "./domain/reservation-service.js";

export async function buildApp({ root, dataDir = path.join(root, "data"), stateDir = path.join(root, ".state"), clock } = {}) {
  const [servicesDoc, windowsDoc, holidaysDoc, historyDoc] = await Promise.all([
    readJson(path.join(dataDir, "services.json")),
    readJson(path.join(dataDir, "windows.json")),
    readJson(path.join(dataDir, "holidays.json")),
    readJson(path.join(dataDir, "history.json")),
  ]);
  const catalog = new Catalog({ services: servicesDoc.services, windows: windowsDoc.windows });
  const calendar = new Calendar({ holidays: holidaysDoc.holidays, makeupWorkdays: holidaysDoc.makeupWorkdays });
  const store = new EventStore({ dir: stateDir });
  const service = new ReservationService({ store, catalog, calendar, clock });
  const replayed = await service.start();
  return { service, catalog, calendar, store, history: historyDoc, replayed };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
