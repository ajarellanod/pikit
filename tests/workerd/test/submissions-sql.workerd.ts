/**
 * submissions-sql, unmodified, over storage-do on a real SQLite-backed Durable Object: the
 * `agent.submissions` suite with the feed suite over `answers`, pruning and restarts, as its own tests
 * run it on a server (a process is an app; a restart is a new app over the same object).
 */

import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentSubmissions } from "@pikit/contracts";
import { createSubmissionsConformance, withWorkersHost } from "@pikit/contracts/testing";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import { it } from "vitest";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import submissionsSql from "../../../registry/components/submissions-sql/files/src/pikit/submissions-sql/index.ts";
import { inObject, objectHost } from "./host.ts";

const DAY = 24 * 60 * 60 * 1_000;

/** One "process" of the component over the object the case runs in. */
async function open(clock: ManualClock): Promise<{ app: App; submissions: AgentSubmissions }> {
  let submissions: AgentSubmissions | undefined;
  const reader = defineComponent({
    name: "submissions-test",
    setup(pikit) {
      const handle = pikit.use("agent.submissions");
      return { start: () => void (submissions = handle.get()) };
    },
  });
  const app = await defineApp({ components: [...withWorkersHost(objectHost(), [storageDo, submissionsSql]), reader], logger: silentLogger, clock }).create();
  await app.start();
  if (submissions === undefined) throw new Error("agent.submissions was not resolved");
  return { app, submissions };
}

// Settlements are pruned after keepSettledDays (7 by default), at start: `prune` restarts eight days later.
for (const c of createSubmissionsConformance(
  async () => {
    const clock = createManualClock();
    let process = await open(clock);
    return {
      submissions: () => process.submissions,
      async prune() {
        await process.app.stop();
        await clock.advance(8 * DAY);
        process = await open(clock);
      },
      async restart() {
        await process.app.stop();
        process = await open(clock);
      },
      dispose: () => process.app.stop(),
    };
  },
  { prunes: true, restarts: true },
)) {
  it(`submissions-sql over storage-do ${c.group}: ${c.name}`, () => inObject(c));
}
