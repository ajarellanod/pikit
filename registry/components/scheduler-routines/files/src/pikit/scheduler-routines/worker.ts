/**
 * scheduler-routines' Worker half, on `durable`: at each start of the Worker's App it asks the routines'
 * actor (`ROUTINES_KEY`, a Durable Object running the default export) to sync them with its config, the
 * objects' App's: the Worker half has no config of its own. A deploy's first request (`/health`) starts
 * the Worker's App, so the routines are synced before the deploy is accepted:
 *
 * - a routine the scheduler refuses (`invalid`) fails the start, so `/health` fails and the deploy rolls
 *   back, as a refused routine stops a server's start;
 * - an actor that cannot be reached is logged, and the next start of a Worker's App asks again.
 *
 * `component.json`'s `apps.worker` names this export (`worker`).
 */

import { defineComponent } from "@pikit/core";
import { ActorCallError } from "@pikit/contracts";
import { ROUTINES_KEY, SYNC } from "./index.ts";

export const worker = defineComponent({
  name: "scheduler-routines-worker",
  setup(pikit) {
    const mailbox = pikit.use("actor.mailbox");
    return {
      async start(ctx) {
        try {
          await mailbox.get().call(ROUTINES_KEY, SYNC, {}, ctx);
        } catch (error) {
          if (error instanceof ActorCallError && error.code === "invalid") throw new Error(error.message);
          ctx.logger.warn("scheduler-routines: the routines could not be synced; the next start asks again", { error: error instanceof Error ? error.message : String(error) });
        }
      },
    };
  },
});
