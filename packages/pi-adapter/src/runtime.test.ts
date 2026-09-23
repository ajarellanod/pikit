/**
 * The adapter's runtime against the `agent.runtime` conformance suite (SPEC §14), on Pi 0.87.1,
 * with a killed process for the dead-worker cases. The wiring below is the least a component needs;
 * `runtime-pi` in the registry is the real one and runs the same suite.
 */

import { test } from "bun:test";
import { BACKGROUND_CONTEXT, defineComponent, type AgentRuntime } from "@pikit/core";
import { createAgentRuntimeConformance } from "@pikit/core/testing";
import { type HarnessHook, modelsFrom, type PiRuntime, createPiRuntime } from "./index.ts";
import { createPiRuntimeFixture } from "./testing/index.ts";

export function wiring(onHarness?: HarnessHook) {
  return defineComponent({
    name: "runtime-adapter-test",
    setup(pikit) {
      const sessions = pikit.use("sessions.store");
      const agents = pikit.useKeyed("agent.definition");
      const providers = pikit.useKeyed("model.provider");
      let runtime: PiRuntime | undefined;
      const current = (): PiRuntime => {
        if (runtime === undefined) throw new Error("agent.runtime used before start");
        return runtime;
      };
      const delegate: AgentRuntime = {
        dispatch: (request, ctx) => current().dispatch(request, ctx),
        abort: (conversation, ctx) => current().abort(conversation, ctx),
        resume: (conversation, ctx) => current().resume(conversation, ctx),
      };
      pikit.provide("agent.runtime", delegate);
      return {
        start(ctx) {
          runtime = createPiRuntime({
            sessions: sessions.get(),
            agent: (name) => agents.get(name),
            models: modelsFrom(providers.keys().flatMap((key) => providers.get(key) ?? [])),
            events: ctx.derive(() => BACKGROUND_CONTEXT),
            ...(onHarness !== undefined && { onHarness }),
          });
        },
        async stop(ctx) {
          await runtime?.close(ctx);
        },
      };
    },
  });
}

for (const c of createAgentRuntimeConformance(() => createPiRuntimeFixture(({ onHarness }) => [wiring(onHarness)]))) {
  test(`${c.group}: ${c.name}`, () => c.run(), 30_000);
}
