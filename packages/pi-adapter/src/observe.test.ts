/**
 * `agent.observe` on pi-durable (`observe.ts`): the contracts' suite on a runtime wired as runtime-pi
 * wires it, over a SQLite `storage.sql`, and what only pi-durable shows: a conversation is busy while
 * its run goes, a subagent's conversation is not listed, a cursor is checked.
 */

import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineComponent, withAbortSignal } from "@pikit/core";
import { createAgentObserveConformance } from "@pikit/contracts/testing";
import { createObserver } from "./observe.ts";
import { modelsFrom } from "./models.ts";
import { createDurableRuntime, type DurableRuntime } from "./runtime.ts";
import { databaseFile, openWorker, releasableHold, scriptedAgent } from "./test-support.ts";
import { testComponents } from "./testing/index.ts";

/** The runtime as runtime-pi provides it: `agent.runtime`, `agent.conversations`, `agent.observe`. */
const runtimeObserved = defineComponent({
  name: "runtime-observed",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const agents = pikit.useKeyed("agent.definition");
    const providers = pikit.useKeyed("model.provider");
    let opened: DurableRuntime | undefined;
    const current = (): DurableRuntime => {
      if (opened === undefined) throw new Error("used while the app is not running");
      return opened;
    };
    pikit.provide("agent.runtime", {
      dispatch: (request, ctx) => current().dispatch(request, ctx),
      abort: (conversation, ctx) => current().abort(conversation, ctx),
      resume: (conversation, ctx) => current().resume(conversation, ctx),
    });
    pikit.provide("agent.conversations", { create: (ctx) => current().createConversation(ctx) });
    pikit.provide("agent.observe", createObserver(current));
    return {
      start(ctx) {
        opened = createDurableRuntime({
          db: sql.get(),
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

for (const c of createAgentObserveConformance(() => {
  const { storage, agents, provider } = testComponents();
  return { components: [storage, agents, provider, runtimeObserved], agent: "scripted" };
})) {
  test(`${c.group}: ${c.name}`, () => c.run(), 30_000);
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function worker(options: Parameters<typeof openWorker>[1] = {}) {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const w = await openWorker(file.path, options);
  cleanup.push(w.close);
  return { ...w, observe: createObserver(() => w.runtime) };
}

test("a conversation is busy while its run goes, and idle once it ends; its live tool shows in watch", async () => {
  const hold = releasableHold();
  const w = await worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  const stop = new AbortController();
  const events = w.observe.watch(conversation.conversationId, w.ctx.derive((inner) => withAbortSignal(stop.signal, inner)))[Symbol.asyncIterator]();
  expect((await events.next()).value?.type).toBe("snapshot");

  await w.dispatch("r1", "hold", conversation);
  await hold.started;
  const busy = await w.observe.conversation(conversation.conversationId, w.ctx);
  const types: string[] = [];
  while (!types.includes("tool_execution_start")) types.push((await events.next()).value?.type ?? "end");
  hold.release();
  await w.result("r1");
  const idle = await w.observe.conversation(conversation.conversationId, w.ctx);
  stop.abort();

  expect(busy?.busy).toBe(true);
  expect(idle?.busy).toBe(false);
  expect(types).toContain("run_start");
  while (!(await events.next()).done);
});

test("a cursor the observer did not give, or a page of 0, is refused", async () => {
  const w = await worker();
  await w.conversation();

  await expect(w.observe.conversations({ cursor: "not json" }, w.ctx)).rejects.toThrow("the cursor is not one this observer gave");
  await expect(w.observe.conversations({ limit: 0 }, w.ctx)).rejects.toThrow("a page's limit is a positive integer");
});
