/**
 * The contracts' `agent.runtime` conformance suite (@pikit/contracts/testing) on the durable runtime,
 * each worker an app over the same SQLite file.
 *
 * Three cases describe the old runtime's steering, which pi-durable's follow-ups replace (README.md,
 * "Admission"), and are not run: a message queued while a run is going gets a run of its own once that
 * run ends, instead of being answered by it (`requestIds` `[r1, r2]`). Their scenarios, with the new
 * expectation, are in runtime.test.ts and recovery.test.ts. The switch-over updates the suite.
 */

import { afterAll, test } from "bun:test";
import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentRuntime, ConversationRef } from "@pikit/contracts";
import { type AgentRuntimeFixture, createAgentRuntimeConformance } from "@pikit/contracts/testing";
import { createModels } from "pi-ai-v1/models";
import { openSqliteDatabase } from "../testing/sqlite.ts";
import { createDurableRuntime, type DurableRuntime } from "./runtime.ts";
import { openDurableStorage } from "./sql.ts";
import { databaseFile, holdTool, scriptedAgent, scriptedProvider } from "./test-support.ts";

/** The cases of the old steering semantics (see above). */
const STEERING = new Set([
  "a message to a busy conversation is queued and the run in progress answers it",
  "a message that arrives as the run ends is answered by that run",
  "a message to a conversation with an interrupted run resumes it, and that run answers",
]);

const files: (() => void)[] = [];
/** The context of steps outside any worker: making a conversation, a worker that dies. */
const outside = (await defineApp({ components: [], logger: silentLogger }).create()).context();
afterAll(() => {
  for (const dispose of files) dispose();
});

function fixture(): AgentRuntimeFixture {
  const file = databaseFile();
  files.push(file.dispose);

  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holdStarted = new Promise<void>((resolve) => (started = resolve));
  const hold = holdTool(async (context) => {
    started();
    await new Promise<void>((resolve, reject) => {
      const signal = context.abortSignal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void released.then(resolve);
    });
    return "released";
  });

  type Gate = { reach(): void; released: Promise<void> };
  let failing: Gate | undefined;
  const fail = (): Promise<string> | undefined => {
    const armed = failing;
    if (armed === undefined) return undefined;
    failing = undefined;
    armed.reach();
    return armed.released.then(() => "scripted failure");
  };
  const provider = scriptedProvider({ fail });
  const agent = scriptedAgent([hold as never]);

  /** The runtime of the worker running now: one Harness per storage, so conversations are made through it. */
  let current: DurableRuntime | undefined;
  const open = () => {
    const sqlite = openSqliteDatabase(file.path);
    const models = createModels();
    models.setProvider(provider);
    return { sqlite, models };
  };
  const runtimeOver = (events: Parameters<typeof createDurableRuntime>[0]["events"]) => {
    const { sqlite, models } = open();
    const runtime = createDurableRuntime({
      storage: () => openDurableStorage(sqlite.database),
      agent: (name) => (name === agent.name ? agent : undefined),
      models,
      events,
    });
    return { runtime, close: async () => (await runtime.close(events), await sqlite.close()) };
  };

  const component: ComponentDefinition = defineComponent({
    name: "runtime-durable",
    setup(pikit) {
      let opened: ReturnType<typeof runtimeOver> | undefined;
      const use = (): AgentRuntime => {
        if (opened === undefined) throw new Error("agent.runtime used while the app is not running");
        return opened.runtime;
      };
      pikit.provide("agent.runtime", {
        dispatch: (request, ctx) => use().dispatch(request, ctx),
        abort: (conversation, ctx) => use().abort(conversation, ctx),
        resume: (conversation, ctx) => use().resume(conversation, ctx),
      });
      return {
        start(ctx) {
          opened = runtimeOver(ctx.derive(() => BACKGROUND_CONTEXT));
          current = opened.runtime;
        },
        async stop() {
          if (current === opened?.runtime) current = undefined;
          await opened?.close();
          opened = undefined;
        },
      };
    },
  });

  const conversation = async (): Promise<ConversationRef> => {
    if (current !== undefined) {
      const sessionId = await current.createConversation(outside);
      return { key: `test:durable:${sessionId}`, agent: agent.name, sessionId };
    }
    const temporary = runtimeOver(outside);
    try {
      const sessionId = await temporary.runtime.createConversation(outside);
      return { key: `test:durable:${sessionId}`, agent: agent.name, sessionId };
    } finally {
      await temporary.close();
    }
  };

  return {
    components: [
      component,
      defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    ],
    conversation,
    hold: { started: holdStarted, release: () => release() },
    holdAtEnd() {
      throw new Error("only the steering cases pause a run at its end; they are not run here");
    },
    failNext() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      failing = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    async interrupted() {
      // A worker that dies mid-run: its Harness closes while the hold tool runs, leaving the run pending.
      const dying = runtimeOver(outside);
      const sessionId = await dying.runtime.createConversation(outside);
      const ref = { key: `test:durable:${sessionId}`, agent: agent.name, sessionId };
      await dying.runtime.dispatch({ requestId: "r-crashed", conversation: ref, prompt: "hold" }, outside);
      await holdStarted;
      await dying.close();
      return { conversation: ref, requestId: "r-crashed" };
    },
  };
}

for (const c of createAgentRuntimeConformance(fixture)) {
  if (!STEERING.has(c.name)) test(`${c.group}: ${c.name}`, () => c.run());
}
