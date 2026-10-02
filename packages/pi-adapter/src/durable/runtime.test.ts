/**
 * The durable runtime (`runtime.ts`) on pi-durable over `storage.sql` (a SQLite file, as
 * storage-sqlite provides it), with pi-ai 1.0's faux provider: the old runtime's scenarios
 * (adapter.test.ts) as consumers see them, through `dispatch`, `abort`, `resume` and the `agent.*`
 * events.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, createContextKey, defineApp, defineComponent, silentLogger, withCancel, withContextValue } from "@pikit/core";
import { CONVERSATION, defineAgent } from "@pikit/contracts";
import { createModels } from "pi-ai-v1/models";
import { createDurableRuntime } from "./runtime.ts";
import { openDurableStorage } from "./sql.ts";
import { databaseFile, holdTool, openWorker, releasableHold, scriptedAgent, scriptedProvider, type Worker } from "./test-support.ts";
import { openSqliteDatabase } from "../testing/sqlite.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A worker over a fresh database file, closed after the test. */
async function worker(options: Parameters<typeof openWorker>[1] = {}): Promise<Worker & { path: string }> {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const w = await openWorker(file.path, options);
  cleanup.push(() => w.close());
  return { ...w, path: file.path };
}

describe("answers", () => {
  test("an idle conversation starts a run: agent.dispatched, agent.started, then agent.settled with the run's messages", async () => {
    const w = await worker();
    const conversation = await w.conversation();

    expect(await w.dispatch("r1", "hello", conversation)).toEqual({ kind: "started", requestId: "r1" });
    const result = await w.result("r1");

    expect([result.kind, result.text, result.requestIds]).toEqual(["completed", "answer: hello", ["r1"]]);
    expect(result.conversation).toEqual(conversation);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(w.events.map((e) => e.name)).toEqual(["agent.dispatched", "agent.started", "agent.settled"]);
    expect(w.events[1]?.payload).toEqual({ conversation, requestId: "r1", resumed: false });
  });

  test("a second message: its result carries only its own run", async () => {
    const w = await worker();
    const conversation = await w.conversation();
    await w.dispatch("r1", "one", conversation);
    await w.result("r1");
    await w.dispatch("r2", "two", conversation);

    const second = await w.result("r2");

    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(second.messages[0]).toMatchObject({ role: "user", content: "two" });
    expect(second.text).toBe("answer: two");
  });

  test("a run with a tool: the tool call, its result and the answer", async () => {
    const hold = releasableHold();
    const w = await worker({ agents: [scriptedAgent([hold.tool as never])] });
    const conversation = await w.conversation();
    hold.release();

    await w.dispatch("r1", "hold", conversation);
    const result = await w.result("r1");

    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(result.text).toBe("answer: hold");
  });

  test("an unknown agent or conversation rejects the dispatch", async () => {
    const w = await worker();
    const conversation = await w.conversation();

    await expect(w.dispatch("r1", "hi", { ...conversation, agent: "nobody" })).rejects.toThrow('no agent.definition "nobody"');
    await expect(w.dispatch("r1", "hi", { ...conversation, sessionId: "999" })).rejects.toThrow("no pi-durable conversation 999");
    await expect(w.dispatch("r1", "hi", { ...conversation, sessionId: "a-pi-0.99-session" })).rejects.toThrow("not a pi-durable conversation id");
  });

  test("each agent runs on the provider its model names", async () => {
    const support = defineAgent({ name: "support", model: "faux/scripted" });
    const sales = defineAgent({ name: "sales", model: "other/scripted" });
    const w = await worker({ agents: [support, sales], providers: [scriptedProvider(), scriptedProvider({ id: "other" })] });

    await w.dispatch("r1", "hi", await w.conversation("support"));
    await w.dispatch("r2", "hi", await w.conversation("sales"));

    const providerOf = async (requestId: string) =>
      (await w.result(requestId)).messages.flatMap((message) => (message.role === "assistant" ? [(message as { provider: string }).provider] : []));
    expect(await providerOf("r1")).toEqual(["faux"]);
    expect(await providerOf("r2")).toEqual(["other"]);
  });

  test("agent.started comes before the run's result, even when agent.dispatched is slow to listen", async () => {
    const order: string[] = [];
    const observer = defineComponent({
      name: "order",
      setup(pikit) {
        pikit.on("agent.dispatched", async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push("dispatched");
        });
        pikit.on("agent.started", () => void order.push("started"));
        pikit.on("agent.settled", () => void order.push("settled"));
      },
    });
    const app = await defineApp({ components: [observer], logger: silentLogger }).create();
    const file = databaseFile();
    cleanup.push(file.dispose);
    const sqlite = openSqliteDatabase(file.path);
    const models = createModels();
    models.setProvider(scriptedProvider());
    const agent = scriptedAgent();
    const runtime = createDurableRuntime({
      storage: () => openDurableStorage(sqlite.database),
      agent: (name) => (name === agent.name ? agent : undefined),
      models,
      events: app.context(),
    });
    cleanup.push(async () => {
      await runtime.close(app.context());
      await sqlite.close();
    });
    const sessionId = await runtime.createConversation(app.context());

    await runtime.dispatch({ requestId: "r1", conversation: { key: "test:order", agent: agent.name, sessionId }, prompt: "hello" }, app.context());
    for (let i = 0; i < 100 && !order.includes("settled"); i++) await Bun.sleep(5);

    expect(order).toEqual(["dispatched", "started", "settled"]);
  });
});

describe("busy conversations", () => {
  test("a message to a busy conversation is queued; it gets a run of its own once the run in progress ends", async () => {
    const hold = releasableHold();
    const w = await worker({ agents: [scriptedAgent([hold.tool as never])] });
    const conversation = await w.conversation();
    await w.dispatch("r1", "hold", conversation);
    await hold.started;

    expect(await w.dispatch("r2", "change course", conversation)).toEqual({ kind: "queued", requestId: "r2" });
    expect(w.runtime.holds(conversation)).toBe(true);
    hold.release();

    const first = await w.result("r1");
    expect([first.kind, first.text, first.requestIds]).toEqual(["completed", "answer: hold", ["r1"]]);
    expect(await w.started("r2")).toEqual({ conversation, requestId: "r2", resumed: false });
    const second = await w.result("r2");
    expect([second.kind, second.text, second.requestIds]).toEqual(["completed", "answer: change course", ["r2"]]);
    expect(await w.runtime.whenIdle(w.ctx)).toBe(true);
    expect(w.runtime.holds(conversation)).toBe(false);
  });

  test("a repeated requestId is a duplicate: settled, running, queued, and concurrent", async () => {
    const hold = releasableHold();
    const w = await worker({ agents: [scriptedAgent([hold.tool as never])] });
    const settled = await w.conversation();
    await w.dispatch("r1", "hello", settled);
    await w.result("r1");
    expect(await w.dispatch("r1", "hello", settled)).toEqual({ kind: "duplicate", requestId: "r1" });

    const busy = await w.conversation();
    await w.dispatch("r2", "hold", busy);
    await hold.started;
    expect(await w.dispatch("r2", "hold", busy)).toEqual({ kind: "duplicate", requestId: "r2" });
    await w.dispatch("r3", "change course", busy);
    expect(await w.dispatch("r3", "change course", busy)).toEqual({ kind: "duplicate", requestId: "r3" });
    hold.release();
    await w.result("r3");

    const concurrent = await w.conversation();
    const kinds = (await Promise.all([w.dispatch("r4", "hello", concurrent), w.dispatch("r4", "hello", concurrent)])).map((a) => a.kind).sort();
    expect(kinds).toEqual(["duplicate", "started"]);
    await w.result("r4");
    await w.runtime.whenIdle(w.ctx);
    expect(w.events.filter((e) => e.name === "agent.started" && e.payload.requestId === "r4")).toHaveLength(1);
    expect(w.results().map((r) => r.requestId)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  test("a message queued behind a run that fails gets a run of its own, and its answer", async () => {
    let requests = 0;
    let release!: () => void;
    const released = new Promise<string>((resolve) => (release = () => resolve("scripted failure")));
    const fail = () => (requests === 1 ? released : undefined);
    const w = await worker({ providers: [scriptedProvider({ onRequest: () => void requests++, fail })] });
    const conversation = await w.conversation();

    await w.dispatch("r1", "hello", conversation);
    while (requests === 0) await Bun.sleep(1);
    expect(await w.dispatch("r2", "are you there?", conversation)).toEqual({ kind: "queued", requestId: "r2" });
    release();

    const failed = await w.result("r1");
    expect([failed.kind, failed.requestIds, failed.error]).toEqual(["failed", ["r1"], { code: "model_error", message: "scripted failure" }]);
    expect(await w.started("r2")).toEqual({ conversation, requestId: "r2", resumed: false });
    const answered = await w.result("r2");
    expect([answered.kind, answered.text]).toEqual(["completed", "answer: are you there?"]);
    expect(requests).toBe(2);
  });
});

describe("abort", () => {
  test("abort() stops the run; a message queued in it is withdrawn and stays a duplicate", async () => {
    const hold = releasableHold();
    const w = await worker({ agents: [scriptedAgent([hold.tool as never])] });
    const conversation = await w.conversation();
    await w.dispatch("r1", "hold", conversation);
    await hold.started;
    await w.dispatch("r2", "change course", conversation);

    await w.runtime.abort(conversation, w.ctx);

    const aborted = await w.result("r1");
    expect([aborted.kind, aborted.requestIds]).toEqual(["aborted", ["r1"]]);
    expect(await w.dispatch("r2", "change course", conversation)).toEqual({ kind: "duplicate", requestId: "r2" });
    expect((await w.dispatch("r3", "hello", conversation)).kind).toBe("started");
    expect((await w.result("r3")).text).toBe("answer: hello");
    // The withdrawn request never ran: no event of its own.
    expect(w.results().map((r) => r.requestId)).toEqual(["r1", "r3"]);
  });
});

describe("contexts", () => {
  test("a tool sees its conversation and a cancelled caller does not stop the run; abort() signals the tool", async () => {
    const TENANT = createContextKey<string>("tenant");
    let seen!: (context: import("@earendil-works/chord").Context) => void;
    const inTool = new Promise<import("@earendil-works/chord").Context>((resolve) => (seen = resolve));
    const hold = holdTool(
      (context) =>
        new Promise<string>((_, reject) => {
          seen(context);
          context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true });
        }),
    );
    const w = await worker({ agents: [scriptedAgent([hold as never])] });
    const conversation = await w.conversation();
    const { context, cancel } = withCancel(withContextValue(TENANT, "acme", BACKGROUND_CONTEXT));

    await w.dispatch("r1", "hold", conversation, w.app.context(context));
    const toolContext = await inTool;
    expect(toolContext.value(CONVERSATION)).toEqual(conversation);
    cancel();
    expect(toolContext.abortSignal?.aborted).toBe(false);

    await w.runtime.abort(conversation, w.ctx);

    expect(toolContext.abortSignal?.aborted).toBe(true);
    expect((await w.result("r1")).kind).toBe("aborted");
  });
});
