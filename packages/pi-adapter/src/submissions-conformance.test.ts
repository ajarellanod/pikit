/**
 * The contracts' `agent.submissions` conformance suite (@pikit/contracts/testing) on its real provider:
 * the durable runtime runtime-pi provides it from, over pi-durable on storage-sqlite's `storage.sql`,
 * each restart a new app over the same file. `createPiSubmissionsFixture` (`./testing/submissions.ts`)
 * makes the runtime record what the suite writes, through its messages, its runs and `abandon`.
 *
 * Without `prunes`: the runtime's `get` reads a request's settlement from pi-durable once the answers
 * log has pruned it (the contract allows it), so the suite's pruning case does not apply. The log's own
 * pruning runs under the feed suite in `answers.test.ts`.
 */

import { afterAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubmissionsConformance } from "@pikit/contracts/testing";
import storageSqlite from "../../../registry/components/storage-sqlite/files/src/pikit/storage-sqlite/index.ts";
import { createPiSubmissionsFixture } from "./testing/submissions.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

for (const c of createSubmissionsConformance(
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pikit-submissions-"));
    directories.push(dir);
    return createPiSubmissionsFixture({ components: [storageSqlite], config: { "storage-sqlite": { path: join(dir, "pikit.db") } } });
  },
  { restarts: true },
)) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run(), 30_000);
}
