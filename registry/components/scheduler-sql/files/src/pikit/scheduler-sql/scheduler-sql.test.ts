/**
 * scheduler-sql: the `scheduler` suite (conformance.ts) over a SQLite file and the in-memory wakeups
 * double (which, like wakeups-timers, forgets its requests at a restart), and what the suite cannot
 * pin: what setup declares, and cron ticks across a change of time.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, silentLogger } from "@pikit/core";
import { createMemoryWakeups } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createSchedulerConformance } from "./conformance.ts";
import schedulerSql, { GRACE_MS, nextTick } from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-scheduler-sql-"));
  directories.push(dir);
  return { components: [sqliteStorage(join(dir, "pikit.db")), createMemoryWakeups(), schedulerSql] };
};

for (const c of createSchedulerConformance(fixture, { graceMs: GRACE_MS })) test(`${c.group}: ${c.name}`, () => c.run());

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: fixture().components, logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "scheduler-sql")).toMatchObject({
    provides: ["scheduler"],
    requires: ["storage.sql", "wakeups"],
    optional: [],
  });
});

test("a cron tick keeps its local time across a change of time: 08:00 in Madrid is 07:00 UTC in winter, 06:00 UTC in summer", () => {
  const daily = { cron: "0 8 * * *", timezone: "Europe/Madrid" };
  expect(new Date(nextTick(daily, Date.UTC(2026, 2, 28, 12)) as number).toISOString()).toBe("2026-03-29T06:00:00.000Z");
  expect(new Date(nextTick(daily, Date.UTC(2026, 2, 27, 12)) as number).toISOString()).toBe("2026-03-28T07:00:00.000Z");
  // Strictly after: a tick at its own time is followed by the next one.
  expect(nextTick(daily, Date.UTC(2026, 2, 29, 6))).toBe(Date.UTC(2026, 2, 30, 6));
});
