/**
 * outbound-durable's tests. They are copied with the component and keep running in your project.
 * Every database is a temporary SQLite file.
 */

import { afterAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleConformance, createOutboundQueueConformance } from "@pikit/core/testing";
import outboundDurable from "./index.ts";
import { testStorage } from "./storage.test-support.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-outbound-durable-"));
  directories.push(dir);
  return join(dir, "pikit.db");
}

// The outbound.queue contract (SPEC §5, §14): order, retries, abandonment, duplicates, restarts.
for (const c of createOutboundQueueConformance(() => ({ components: [testStorage(temporaryDatabase()), outboundDurable] }))) {
  test(`outbound-durable ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline.
const lifecycleDatabase = temporaryDatabase();
for (const c of createLifecycleConformance(() => ({ component: outboundDurable, providers: [testStorage(lifecycleDatabase)] }))) {
  test(`outbound-durable ${c.group}: ${c.name}`, () => c.run());
}
