/**
 * log-events: one structured log line per operational event, through the app's `Logger` (SPEC §9.1,
 * §13). Installing it is what turns these lines on; removing it turns them off. Where the lines go
 * and in which format (console, JSON lines in a container) is the logger's job, not this one.
 *
 *   agent.dispatched     conversation, agent, session, requestId, admission
 *   agent.started        conversation, agent, session, requestId, resumed
 *   agent.settled        conversation, agent, session, requestId, requestIds, run, messages,
 *   agent.failed           durationMs?, tokens, cost, errorCode?
 *   conversation.reset   conversation, agent, session, previousSession
 *   pipeline.halted      pipeline, stage, reason
 *   runtime.*            no fields
 *
 * Privacy: no line carries a message's text, a prompt, an answer or an error message, and nothing
 * here reads a secret. See `fields.ts`, which picks each field by name.
 *
 * Events are notifications (SPEC §4.3): every listener catches its own failures, including a logger
 * that throws, so logging can never fail the code that emitted the event.
 *
 * Duration is measured with `ctx.clock` from `agent.started` to the run's end. The start times are
 * a cache in this process: a run started by a worker that died, or before a Durable Object
 * hibernated, ends without `durationMs`, which is better than a wrong one.
 *
 * Targets: `server` and `cloudflare` (it imports nothing platform-specific).
 */

import { type AppContext, type AppEvents, defineComponent } from "@pikit/core";
import { admissionFields, conversationFields, type Fields, resetFields, resultFields } from "./fields.ts";

/**
 * Most start times kept at once. A run that never ends in this process (its worker was stopped
 * mid-run) would otherwise stay in the cache forever; past the bound, the oldest is dropped.
 */
const MAX_RUNNING = 10_000;

type Level = "debug" | "info" | "warn" | "error";

export default defineComponent({
  name: "log-events",
  setup(pikit) {
    /** Start time of each run in progress, by `session/requestId` (a run's id is its starter's). */
    const started = new Map<string, number>();
    const runKey = (sessionId: string, requestId: string) => `${sessionId}/${requestId}`;

    /** Register a listener that logs one line and can never throw. */
    const log = <K extends keyof AppEvents & string>(
      event: K,
      line: (payload: AppEvents[K], ctx: AppContext) => { level: Level; fields?: Fields },
    ) => {
      pikit.on(event, (payload, ctx) => {
        try {
          const { level, fields } = line(payload, ctx);
          ctx.logger[level](event, fields);
        } catch (error) {
          try {
            ctx.logger.warn("log-events could not log an event", {
              event,
              error: error instanceof Error ? error.name : typeof error,
            });
          } catch {
            // The logger itself is failing; there is nowhere left to report it.
          }
        }
      });
    };

    log("agent.dispatched", ({ conversation, admission }) => ({ level: "info", fields: admissionFields(conversation, admission) }));

    log("agent.started", ({ conversation, requestId, resumed }, ctx) => {
      started.set(runKey(conversation.sessionId, requestId), ctx.clock.now());
      if (started.size > MAX_RUNNING) started.delete(started.keys().next().value as string);
      return { level: "info", fields: { ...conversationFields(conversation), requestId, resumed } };
    });

    const ended = (result: AppEvents["agent.settled"] | AppEvents["agent.failed"], ctx: AppContext) => {
      const key = runKey(result.conversation.sessionId, result.requestId);
      const since = started.get(key);
      started.delete(key);
      const durationMs = since === undefined ? undefined : Math.max(0, ctx.clock.now() - since);
      return resultFields(result, durationMs);
    };
    log("agent.settled", (result, ctx) => ({ level: result.kind === "aborted" ? "warn" : "info", fields: ended(result, ctx) }));
    log("agent.failed", (result, ctx) => ({ level: "error", fields: ended(result, ctx) }));

    log("conversation.reset", (reset) => ({ level: "info", fields: resetFields(reset) }));

    // A halt reason is the stage's own short reason ("duplicate", "unauthorized"), logged as is.
    log("pipeline.halted", ({ pipeline, stage, reason }) => ({ level: "info", fields: { pipeline, stage, reason } }));

    for (const event of ["runtime.starting", "runtime.ready", "runtime.stopping", "runtime.stopped"] as const) {
      log(event, () => ({ level: "info" }));
    }
  },
});
