/**
 * The `agent.runtime` conformance fixture on Pi (pi-durable), whatever keeps its records. The records
 * are a `storage.sql` the caller provides: `createPiRuntimeFixture` keeps them in a SQLite file
 * (`./fixture.ts`), the workerd lane in a Durable Object's SQL (storage-do). Neutral: it imports no
 * runtime module.
 *
 * The runtime under test is built by the caller, so the same fixture checks the adapter and the
 * `runtime-pi` component. The fixture provides what it uses: the scripted `agent.definition` and the
 * `faux` `model.provider`; the records provide `storage.sql`.
 *
 * pi-durable allows one Harness per storage. A conversation is made through the running worker's
 * `agent.conversations` when there is one, and otherwise through a runtime opened over the records
 * for that step and closed again. A worker that dies mid-run is such a runtime too, closed while its
 * `hold` call runs: what a closed Harness leaves (the run `placed`, the tool call's intent recorded) is
 * what a killed process or an evicted object leaves.
 */

import { type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentConversations, AgentDefinition, ConversationRef, SqlDatabase } from "@pikit/contracts";
import type { AgentRuntimeFixture } from "@pikit/contracts/testing";
import { modelsFrom } from "../models.ts";
import { createDurableRuntime } from "../runtime.ts";
import { openDurableStorage } from "../sql.ts";
import { holdTool, scriptedAgent, scriptedProvider, type ScriptedProviderOptions } from "./script.ts";

/** Where a runtime fixture keeps what outlives a worker. */
export interface RuntimeFixtureRecords {
  /** Given to every worker: they provide `storage.sql` over the records. */
  components: ComponentDefinition[];
  /** The records' database, for a step outside any worker; `close` closes it (not the records). */
  open(): Promise<{ database: SqlDatabase; close(): Promise<void> }>;
  /** Release what the records hold (a file, a database). */
  dispose?(): Promise<void>;
}

type Gate = { reach(): void; released: Promise<void> };

function gate(): { gate: Gate; reached: Promise<void>; release(): void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { gate: { reach, released: new Promise<void>((resolve) => (release = resolve)) }, reached, release: () => release() };
}

export function createRuntimeFixture(runtime: ComponentDefinition[], records: RuntimeFixtureRecords): AgentRuntimeFixture {
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

  let failing: Gate | undefined;
  let ending: Gate | undefined;
  const take = (armed: Gate | undefined) => {
    armed?.reach();
    return armed?.released;
  };
  const fail = (): Promise<string> | undefined => {
    const armed = failing;
    failing = undefined;
    return take(armed)?.then(() => "scripted failure");
  };
  const atEnd = (): Promise<void> | undefined => {
    const armed = ending;
    ending = undefined;
    return take(armed);
  };

  const agent = scriptedAgent(hold);
  const support = testComponents({ agents: [agent], fail, atEnd });

  /** The `agent.conversations` of the worker running now, if one is. */
  let live: AgentConversations | undefined;
  const probe = defineComponent({
    name: "conversations-probe",
    setup(pikit) {
      const handle = pikit.use("agent.conversations");
      let mine: AgentConversations | undefined;
      return {
        start() {
          mine = handle.get();
          live = mine;
        },
        stop() {
          if (live === mine) live = undefined;
        },
      };
    },
  });

  const refOf = (conversationId: string): ConversationRef => ({ key: `test:pi:${conversationId}`, agent: agent.name, conversationId });

  const conversation = async (): Promise<ConversationRef> => {
    const running = live;
    if (running !== undefined) return refOf(await running.create((await defineApp({ components: [], logger: silentLogger }).create()).context()));
    return refOf(await overRecords(records.open, agent, (opened, ctx) => opened.createConversation(ctx)));
  };

  return {
    components: [...records.components, support.agents, support.provider, probe, ...runtime],
    conversation,
    hold: { started: holdStarted, release: () => release() },
    holdAtEnd() {
      const armed = gate();
      ending = armed.gate;
      return { reached: armed.reached, release: armed.release };
    },
    failNext() {
      const armed = gate();
      failing = armed.gate;
      return { reached: armed.reached, release: armed.release };
    },
    async interrupted() {
      const requestId = "r-crashed";
      return { conversation: await interruptRun(records.open, { requestId }), requestId };
    },
    dispose: async () => records.dispose?.(),
  };
}

/**
 * A worker that dies mid-run, over the records `open` gives (no other worker may run over them): it
 * creates a conversation of the scripted agent (key `test:pi:<id>` unless `key`), dispatches `hold`
 * as `requestId`, and closes its Harness while the tool runs. What it leaves is what a killed process
 * or an evicted object leaves: the request held, the tool call's intent recorded, the run open.
 * `replay`: the `hold` tool's (default `unsafe`: the next worker gives the model an interrupted
 * result instead of running it again).
 */
export async function interruptRun(
  open: RuntimeFixtureRecords["open"],
  options: { requestId: string; key?: string; replay?: "safe" | "unsafe" },
): Promise<ConversationRef> {
  let holding!: () => void;
  const held = new Promise<void>((resolve) => (holding = resolve));
  const dying = scriptedAgent(
    holdTool(async (context) => {
      holding();
      await new Promise<void>((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true }));
      return "never";
    }, options.replay),
  );
  return overRecords(open, dying, async (opened, ctx) => {
    const id = await opened.createConversation(ctx);
    const conversation = { key: options.key ?? `test:pi:${id}`, agent: dying.name, conversationId: id };
    await opened.dispatch({ requestId: options.requestId, conversation, prompt: "hold" }, ctx);
    await held;
    return conversation;
  });
}

/** A runtime over the records for one step (no worker runs), with `agent`, closed after `work`. */
async function overRecords<T>(
  open: RuntimeFixtureRecords["open"],
  agent: AgentDefinition,
  work: (runtime: ReturnType<typeof createDurableRuntime>, ctx: AppContext) => Promise<T>,
): Promise<T> {
  const { database, close } = await open();
  const ctx = (await defineApp({ components: [], logger: silentLogger }).create()).context();
  const opened = createDurableRuntime({
    storage: () => openDurableStorage(database),
    agent: (name) => (name === agent.name ? agent : undefined),
    models: modelsFrom([scriptedProvider()]),
    events: ctx.derive(() => BACKGROUND_CONTEXT),
  });
  try {
    return await work(opened, ctx);
  } finally {
    await opened.close(ctx);
    await close();
  }
}

/** What a runtime uses, for tests: `agent.definition` and the `faux` provider (`model.provider`). */
export interface TestComponents {
  agents: ComponentDefinition;
  provider: ComponentDefinition;
}

/**
 * Test providers of what `agent.runtime` uses besides its storage: agents default to the scripted one
 * (whose `hold` returns at once); the provider is `faux`, model `faux/scripted`.
 */
export function testComponents(
  options: { agents?: AgentDefinition[]; fail?: ScriptedProviderOptions["fail"]; atEnd?: ScriptedProviderOptions["atEnd"] } = {},
): TestComponents {
  const agents = options.agents ?? [scriptedAgent(holdTool(async () => "released"))];
  const provider = scriptedProvider({ ...(options.fail !== undefined && { fail: options.fail }), ...(options.atEnd !== undefined && { atEnd: options.atEnd }) });
  return {
    agents: defineComponent({
      name: "agents-fixture",
      setup(pikit) {
        for (const agent of agents) pikit.provideKeyed("agent.definition", agent.name, agent);
      },
    }),
    provider: defineComponent({
      name: "provider-faux",
      setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider),
    }),
  };
}

/**
 * A fake `agent.conversations` (ids `c1`, `c2`, …), for the tests of what uses it without a runtime
 * (`conversations.registry` providers). `ids` lists every id it made, across the apps that share it.
 */
export function fakeConversations(): { component: ComponentDefinition; ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    component: defineComponent({
      name: "conversations-fake",
      setup: (pikit) =>
        pikit.provide("agent.conversations", {
          async create() {
            const id = `c${ids.length + 1}`;
            ids.push(id);
            return id;
          },
        }),
    }),
  };
}
