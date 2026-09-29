/**
 * The `wakeups` suite against the memory wakeups the other tests use, forgetful and durable. It proves
 * the suite asks only what the contract promises (S12); `wakeups-timers` is the real component.
 */

import { test } from "bun:test";
import { createMemoryWakeups, createWakeupsConformance } from "./wakeups.ts";

for (const c of createWakeupsConformance(() => ({ components: [createMemoryWakeups({ retryMs: 2_000 })] }), { backoffMs: [2_000] })) {
  test(`memory ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createWakeupsConformance(() => ({ components: [createMemoryWakeups({ retryMs: 2_000, durable: true })] }), { backoffMs: [2_000], durable: true })) {
  test(`durable memory ${c.group}: ${c.name}`, () => c.run());
}
