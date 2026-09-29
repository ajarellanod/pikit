/**
 * The `wakeups` suite against the memory wakeups the other tests use. It proves the suite asks only
 * what the contract promises (S12); `wakeups-timers` is the real component.
 */

import { test } from "bun:test";
import { createMemoryWakeups, createWakeupsConformance } from "./wakeups.ts";

for (const c of createWakeupsConformance(() => ({ components: [createMemoryWakeups({ retryMs: 2_000 })] }), { backoffMs: [2_000] })) {
  test(`memory ${c.group}: ${c.name}`, () => c.run());
}
