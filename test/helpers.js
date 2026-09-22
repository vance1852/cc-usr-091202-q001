import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";

export const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

export async function makeApp(clock) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gov-booking-"));
  const app = await buildApp({ root, stateDir: dir, clock });
  return {
    ...app,
    dir,
    async cleanup() {
      await app.store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function fakeClock(iso) {
  let current = iso;
  return {
    now: () => new Date(current),
    set(iso2) {
      current = iso2;
    },
  };
}

export const ref = (i) => `ref-applicant-${String(i).padStart(3, "0")}`;
