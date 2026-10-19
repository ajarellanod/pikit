/**
 * outbound-durable's tests. They are copied with the component and keep running in your project.
 * Every database is a temporary SQLite file.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createMemoryWakeups, createOutboundQueueConformance } from "@pikit/contracts/testing";
import outboundDurable from "./index.ts";
import { BACKOFF_MS, MAX_AGE_MS } from "./queue.ts";
import { openTestDatabase, testStorage } from "./storage.test-support.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-outbound-durable-"));
  directories.push(dir);
  return join(dir, "pikit.db");
}

// The outbound.queue contract (@pikit/contracts' outbound.ts): order, retries, abandonment, duplicates, restarts.
// The suite holds this component to its own retry policy (queue.ts).
const retry = { waitsMs: BACKOFF_MS, maxAgeMs: MAX_AGE_MS };
for (const c of createOutboundQueueConformance(() => ({ components: [testStorage(temporaryDatabase()), createMemoryWakeups(), outboundDurable] }), { retry })) {
  test(`outbound-durable ${c.group}: ${c.name}`, () => c.run());
}

test("portable SQL alone cannot satisfy the outbox's SQLite requirement", async () => {
  const records = openTestDatabase(temporaryDatabase());
  const portable = defineComponent({ name: "portable-only", setup: (pikit) => void pikit.provide("storage.sql", records.database) });
  try {
    await expect(defineApp({ components: [portable, createMemoryWakeups(), outboundDurable], logger: silentLogger }).create()).rejects.toThrow("storage.sqlite");
  } finally {
    await records.close();
  }
});

// Start and stop honour their deadline.
const lifecycleDatabase = temporaryDatabase();
for (const c of createLifecycleConformance(() => ({ component: outboundDurable, providers: [testStorage(lifecycleDatabase), createMemoryWakeups()] }))) {
  test(`outbound-durable ${c.group}: ${c.name}`, () => c.run());
}
