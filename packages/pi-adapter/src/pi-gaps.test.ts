/**
 * Characterisation of what pi-agent-core 0.99.0 does NOT do for pikit. These tests assert Pi's
 * behaviour on purpose, called directly. The adapter bridges each gap with Pi's own mechanisms
 * (`inbound.ts`, `conversation.ts`), or states the rule it leaves (a tool throws on failure,
 * `tools/index.ts`); if Pi changes, a test fails and the bridge or rule is revisited.
 * The bridges go when the adapter moves to `pi-durable`.
 */

import { describe, expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { modelsFrom } from "./models.ts";
import { holdTool, scriptedProvider } from "./testing/index.ts";

const ctx = BACKGROUND_CONTEXT;

async function openLane(tools = [] as ReturnType<typeof holdTool>[], provider = scriptedProvider()) {
  const session = await new MemorySessionRepo().create({}, ctx);
  const models = modelsFrom([provider]);
  const model = models.getModel("faux", "scripted");
  if (model === undefined) throw new Error("faux/scripted missing");
  const { harness } = await AgentHarness.create({ session, models, model, tools }, ctx);
  return { harness, lane: await harness.lane("main", ctx) };
}

describe("Pi gaps (pi-agent-core 0.99.0)", () => {
  test("gap 1: accept() does not reject a reused operationId; the same request runs twice", async () => {
    const { harness, lane } = await openLane();
    const first = await lane.accept({ kind: "prompt", operationId: "req-1", prompt: "hello" }, ctx);
    expect(first.ok).toBe(true);
    await lane.drive({ operationId: "req-1" }, ctx);

    const again = await lane.accept({ kind: "prompt", operationId: "req-1", prompt: "hello" }, ctx);
    expect(again.ok).toBe(true);
    await lane.drive({ operationId: "req-1" }, ctx);

    const prompts = (await lane.findEntries(undefined, ctx)).filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(prompts).toHaveLength(2);
    await harness.close(ctx);
  });

  test("gap 2: a steer that lands after the run's last boundary waits for the next run", async () => {
    const { harness, lane } = await openLane();
    // Stands for the race: the adapter saw a busy lane, the run settled, then the steer landed.
    const late = await lane.steer("change course", undefined, ctx);
    if (!late.ok) throw late.error;

    expect((await lane.inspectExecution(ctx)).current).toBeNull();
    const watch = await lane.watch(ctx);
    watch.unsubscribe();
    expect(watch.snapshot.queues.map((item) => item.entryId)).toEqual([late.value.entryId]);

    // Nothing answers it until something else starts a run, which then drains it first.
    const next = await lane.prompt("hello", undefined, ctx);
    expect(next.ok).toBe(true);
    const users = (await lane.findEntries({ order: "oldestFirst" }, ctx)).filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(users.map((entry) => entry.id)[0]).toBe(late.value.entryId);
    await harness.close(ctx);
  });

  test("gap 2: a run that fails leaves what was steered during it in the inbox, and starts nothing", async () => {
    let reached!: () => void;
    const inCall = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<string>((resolve) => (release = () => resolve("scripted failure")));
    const { harness, lane } = await openLane([], scriptedProvider({ fail: () => (reached(), released) }));
    const run = lane.prompt("hello", undefined, ctx);
    await inCall;
    const queued = await lane.steer("are you there?", undefined, ctx);
    if (!queued.ok) throw queued.error;
    release();

    const ended = await run;
    expect(ended.ok && "status" in ended.value && ended.value.status).toBe("failed");
    // Still queued, with no run: only a new run takes it (the adapter's `reconcile`).
    expect((await lane.inspectExecution(ctx)).current).toBeNull();
    const watch = await lane.watch(ctx);
    watch.unsubscribe();
    expect(watch.snapshot.queues.map((item) => item.entryId)).toEqual([queued.value.entryId]);
    await harness.close(ctx);
  });

  test("gap 3: steer() takes no request id; only the message itself can carry one", async () => {
    const { harness, lane } = await openLane();
    // The signature is (message, images, context): there is nowhere else to put an id.
    expect(lane.steer.length).toBe(3);
    await harness.close(ctx);
  });

  test("gap 4: abort() takes queued steers out of the inbox and returns them only in memory", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const hold = holdTool(
      (context) =>
        new Promise<string>((_, reject) => {
          started();
          context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true });
        }),
    );
    const { harness, lane } = await openLane([hold]);
    const run = lane.prompt("hold", undefined, ctx);
    await running;
    const queued = await lane.steer("change course", undefined, ctx);
    if (!queued.ok) throw queued.error;

    const aborted = await lane.abort(ctx);

    if (!aborted.ok) throw aborted.error;
    expect(aborted.value.steer).toHaveLength(1);
    const after = await run;
    expect(after.ok && "status" in after.value && after.value.status).toBe("aborted");
    // Neither in the inbox nor in the transcript: a redelivery would look new.
    const watch = await lane.watch(ctx);
    watch.unsubscribe();
    expect(watch.snapshot.queues).toEqual([]);
    const entries = await lane.findEntries(undefined, ctx);
    expect(entries.some((entry) => entry.id === queued.value.entryId)).toBe(false);
    await harness.close(ctx);
  });

  test("tools: a result with `isError: true` is recorded as a success", async () => {
    // pi-agent-core's `AgentToolResult.isError` ("report a failure without throwing") is honoured by
    // its `agent-loop`, not by the harness the adapter drives (`harness/execution/tools.ts`). So a
    // pikit tool throws on failure (`tools/index.ts`, `ToolDefinition.execute`).
    const failing: ReturnType<typeof holdTool> = {
      ...holdTool(async () => ""),
      async execute() {
        return { content: [{ type: "text", text: "it failed" }], details: undefined, isError: true };
      },
    };
    const { harness, lane } = await openLane([failing]);
    const ended = await lane.prompt("hold", undefined, ctx);
    expect(ended.ok).toBe(true);

    const results = (await lane.findEntries(undefined, ctx)).flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    expect(results.map((result) => [result.content, result.isError])).toEqual([[[{ type: "text", text: "it failed" }], false]]);
    await harness.close(ctx);
  });

  test('tools: a tool\'s executionMode "sequential" is ignored; its calls overlap', async () => {
    // Pi's `agent-loop` runs a batch one call at a time when a tool of it is sequential; the harness
    // reads only its own `toolExecution` ("parallel" by default).
    let running = 0;
    let most = 0;
    const alone: ReturnType<typeof holdTool> = {
      ...holdTool(async () => ""),
      name: "alone",
      executionMode: "sequential",
      async execute() {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        return { content: [{ type: "text", text: "done" }], details: undefined };
      },
    };
    const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("alone", {}), fauxToolCall("alone", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("both ran"),
    ]);
    const { harness, lane } = await openLane([alone], faux.provider);
    expect((await lane.prompt("go", undefined, ctx)).ok).toBe(true);

    expect(most).toBe(2);
    await harness.close(ctx);
  });
});
