/**
 * outbound-durable's report to `health` (health.ts): `degraded` while an answer is stuck for over a
 * minute or one was given up within the hour, `up` otherwise; when the report may change with no run;
 * and that a check never throws.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { DeliveryError, type HealthRegistry, type HealthStatus, type OutboundQueue } from "@pikit/contracts";
import { createMemoryWakeups } from "@pikit/contracts/testing";
import { ABANDONED_WINDOW_MS, createHealth, STUCK_AFTER_MS } from "./health.ts";
import outboundDurable from "./index.ts";
import { createStore } from "./store.ts";
import { openTestDatabase, testStorage } from "./storage.test-support.ts";

const directories: string[] = [];
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-outbound-health-"));
  directories.push(dir);
  return join(dir, "pikit.db");
}

/** A `health` that keeps each reporter's last report. */
function recordingHealth() {
  const reports = new Map<string, { status: HealthStatus; reason?: string }>();
  const registry: HealthRegistry = {
    reporter: (name) => ({
      up: () => void reports.set(name, { status: "up" }),
      degraded: (reason) => void reports.set(name, { status: "degraded", reason }),
      down: (reason) => void reports.set(name, { status: "down", reason }),
    }),
    snapshot: () => ({ status: "up", components: [] }),
  };
  return { reports, registry, component: defineComponent({ name: "test-health", setup: (pikit) => void pikit.provide("health", registry) }) };
}

const piece = (key: string, conversationKey = "chat:1") => ({ key, channel: "chat", conversationKey, text: `the text of ${key}` });

async function checked() {
  const db = openTestDatabase(temporaryDatabase());
  open.push(db);
  const store = createStore(db.database);
  await store.migrate();
  const health = recordingHealth();
  const check = createHealth(store, health.registry.reporter("outbound-durable"), silentLogger).check;
  return { store, check, report: () => health.reports.get("outbound-durable") };
}

test("up with nothing held; an answer held over a minute is stuck, counted once, with its last error; never its text", async () => {
  const { store, check, report } = await checked();
  expect(await check(0)).toBeUndefined();
  expect(report()).toEqual({ status: "up" });

  // Two pieces of one answer, stored at 1 s: on their way for a minute, then stuck.
  await store.add([piece("c1:m1#0"), piece("c1:m1#1")], 1_000);
  expect(await check(30_000)).toBe(1_000 + STUCK_AFTER_MS + 1);
  expect(report()).toEqual({ status: "up" });
  await store.markSending("c1:m1#0");
  await store.retryLater("c1:m1#0", { nextAttemptAt: 70_000, failed: true, possibleDuplicate: false, error: "transient: 502 Bad Gateway" });
  expect(await check(1_000 + STUCK_AFTER_MS + 1)).toBeUndefined();
  expect(report()).toEqual({ status: "degraded", reason: "1 answer not delivered for over a minute (last error: transient: 502 Bad Gateway)" });
  expect(JSON.stringify(report())).not.toContain("the text of");

  // Delivered at last: up again.
  for (const head of await store.heads()) {
    await store.markSending(head.key);
    await store.markDelivered(head, 2, "p1", 80_000);
  }
  for (const head of await store.heads()) {
    await store.markSending(head.key);
    await store.markDelivered(head, 1, "p2", 80_000);
  }
  expect(await check(80_000)).toBeUndefined();
  expect(report()).toEqual({ status: "up" });
});

test("an answer given up keeps it degraded for an hour, saying why; then up, and it said when", async () => {
  const { store, check, report } = await checked();
  await store.add([piece("c2:m1#0", "chat:2")], 1_000);
  const [head] = await store.heads();
  if (head === undefined) throw new Error("no head");
  await store.abandon(head, 1, "permanent: Forbidden: bot was blocked by the user", 2_000);

  expect(await check(3_000)).toBe(2_000 + ABANDONED_WINDOW_MS + 1);
  expect(report()).toEqual({ status: "degraded", reason: "1 answer given up in the last hour (permanent: Forbidden: bot was blocked by the user)" });
  expect(await check(2_000 + ABANDONED_WINDOW_MS + 1)).toBeUndefined();
  expect(report()).toEqual({ status: "up" });
});

test("a check that cannot read the records changes nothing and never throws", async () => {
  const health = recordingHealth();
  const reporter = health.registry.reporter("outbound-durable");
  reporter.degraded("before");
  const broken = { healthRows: () => Promise.reject(new Error("database is locked")) };
  expect(await createHealth(broken, reporter, silentLogger).check(1)).toBeUndefined();
  expect(health.reports.get("outbound-durable")).toEqual({ status: "degraded", reason: "before" });
});

test("in an App with health, it reports up at start, and degraded once a delivery run gives an answer up", async () => {
  const health = recordingHealth();
  let queue: OutboundQueue | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const outbound = pikit.use("outbound.queue");
      return {
        start() {
          queue = outbound.get();
          queue.attach("chat", {
            idempotent: true,
            split: (text) => [text],
            send: async () => {
              throw new DeliveryError("permanent", "chat not found");
            },
          });
        },
        async stop() {
          await queue?.detach("chat");
        },
      };
    },
  });
  const app = await defineApp({ components: [testStorage(temporaryDatabase()), createMemoryWakeups(), health.component, outboundDurable, channel], logger: silentLogger }).create();
  await app.start();
  try {
    expect(health.reports.get("outbound-durable")).toEqual({ status: "up" });
    await queue?.enqueue({ idempotencyKey: "c1:m1", channel: "chat", conversationKey: "chat:1", text: "hello" });
    for (let i = 0; i < 200 && health.reports.get("outbound-durable")?.status !== "degraded"; i++) await Bun.sleep(10);
    expect(health.reports.get("outbound-durable")).toEqual({ status: "degraded", reason: "1 answer given up in the last hour (permanent: chat not found)" });
  } finally {
    await app.stop();
  }
});
