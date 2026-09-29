/**
 * The `actor.mailbox` suite against the memory mailbox the other tests use. It proves the suite asks
 * only what the contract promises (S12); `mailbox-local` is the real component.
 */

import { test } from "bun:test";
import { createMailboxConformance, createMemoryMailbox } from "./mailbox.ts";
import { createMemoryWakeups } from "./wakeups.ts";

for (const c of createMailboxConformance((inbox) => ({ components: [inbox, createMemoryMailbox()] }))) {
  test(`memory ${c.group}: ${c.name}`, () => c.run());
}

// The actors' App also provides wakeups: an actor that handles messages and wakes itself composes.
for (const c of createMailboxConformance((inbox) => ({ components: [inbox, createMemoryMailbox(), createMemoryWakeups()] }), { wakeups: true })) {
  test(`memory with wakeups ${c.group}: ${c.name}`, () => c.run());
}
