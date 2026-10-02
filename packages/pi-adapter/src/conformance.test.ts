/**
 * The contracts' `agent.runtime` conformance suite (@pikit/contracts/testing) on the durable runtime,
 * each worker an app over the same SQLite file: `createPiRuntimeFixture` (`./testing`), with a small
 * component that provides the runtime as runtime-pi does (`agent.runtime`, `agent.conversations`).
 * Every case runs, the batching of queued messages into the next run included.
 */

import { test } from "bun:test";
import { BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import type { AgentRuntime } from "@pikit/contracts";
import { createAgentRuntimeConformance } from "@pikit/contracts/testing";
import { modelsFrom } from "./models.ts";
import { createDurableRuntime, type DurableRuntime } from "./runtime.ts";
import { createPiRuntimeFixture } from "./testing/index.ts";

const runtimeDurable = defineComponent({
  name: "runtime-durable",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const agents = pikit.useKeyed("agent.definition");
    const providers = pikit.useKeyed("model.provider");
    let opened: DurableRuntime | undefined;
    const use = (): DurableRuntime => {
      if (opened === undefined) throw new Error("agent.runtime used while the app is not running");
      return opened;
    };
    const runtime: AgentRuntime = {
      dispatch: (request, ctx) => use().dispatch(request, ctx),
      abort: (conversation, ctx) => use().abort(conversation, ctx),
      resume: (conversation, ctx) => use().resume(conversation, ctx),
    };
    pikit.provide("agent.runtime", runtime);
    pikit.provide("agent.conversations", { create: (ctx) => use().createConversation(ctx) });
    return {
      start(ctx) {
        const db = sql.get();
        opened = createDurableRuntime({
          db,
          agent: (name) => agents.get(name),
          models: modelsFrom(providers.keys().flatMap((key) => providers.get(key) ?? [])),
          events: ctx.derive(() => BACKGROUND_CONTEXT),
        });
      },
      async stop(ctx) {
        await opened?.close(ctx);
        opened = undefined;
      },
    };
  },
});

for (const c of createAgentRuntimeConformance(() => createPiRuntimeFixture([runtimeDurable]))) {
  test(`${c.group}: ${c.name}`, () => c.run(), 30_000);
}
