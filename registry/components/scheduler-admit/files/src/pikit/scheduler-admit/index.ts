/**
 * scheduler-admit: each tick of `scheduler` becomes a message in its job's conversation, through
 * `admitInbound`, as a channel's message does. The answer goes where every answer of that
 * conversation goes: the channel that owns its key delivers it from the `answers` feed.
 *
 * - **An honest sender.** The message's channel is `scheduler` and its actor the job's id, so its
 *   sender is `{ channel: "scheduler", id: <job> }` (`RUN_REQUESTS`): never a person of a channel.
 *   Routing sees it as such (`route.resolve`): a router may deny it.
 * - **One tick, one message.** Its id is `scheduler:<job>:<tick>`, so a tick delivered twice (a crash
 *   before the scheduler moved on) is one request: the runtime admits it once (`duplicate` after).
 * - **Only into a conversation that exists.** A key never resolved is left alone (logged, the tick
 *   dropped): admitting would create the conversation with `scheduler` as its channel, which no channel
 *   delivers for, so its answers would reach nobody.
 * - A tick routing stops (`denied`, `halted`, `no_route`) is logged and dropped; a failing capability
 *   rejects, and the scheduler delivers the tick again later.
 *
 * Targets: `server`, as scheduler-sql.
 */

import { defineComponent } from "@pikit/core";
import { admitInbound, type InboundMessage } from "@pikit/contracts";
import type { SchedulerTick } from "./contract.ts";

/** The channel scheduled messages come from, as their sender says. */
export const SCHEDULER_CHANNEL = "scheduler";

/** The message of one tick: its id is the tick's identity, its sender the job. */
export function tickMessage({ job, tick }: SchedulerTick): InboundMessage {
  return { id: `${SCHEDULER_CHANNEL}:${job.id}:${tick}`, channel: SCHEDULER_CHANNEL, conversationId: job.key, actor: { id: job.id }, text: job.prompt };
}

export default defineComponent({
  name: "scheduler-admit",
  setup(pikit) {
    const scheduler = pikit.use("scheduler");
    const runtime = pikit.use("agent.runtime");
    const conversations = pikit.use("conversations.registry");
    return {
      start() {
        scheduler.get().handle(async (tick, ctx) => {
          const fields = { job: tick.job.id, key: tick.job.key, tick: tick.tick };
          if ((await conversations.get().get(tick.job.key, ctx)) === undefined) {
            ctx.logger.warn("scheduler-admit: no conversation has the job's key yet; the tick is dropped (a scheduled prompt never starts a conversation)", fields);
            return;
          }
          const outcome = await admitInbound(ctx, tickMessage(tick), { conversations: conversations.get(), runtime: runtime.get(), key: tick.job.key });
          if (outcome.kind === "admitted" || outcome.kind === "duplicate") ctx.logger.info(`scheduler-admit: a tick ${outcome.kind === "admitted" ? "admitted" : "already admitted"}`, fields);
          else ctx.logger.warn(`scheduler-admit: a tick was not admitted (${outcome.kind}); it is dropped`, { ...fields, ...("reason" in outcome && { reason: outcome.reason }) });
        });
      },
    };
  },
});
