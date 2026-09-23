/**
 * Characterisation of what pi-agent-core 0.87.1 does NOT do for pikit. These tests assert Pi's
 * behaviour on purpose, called directly. The adapter bridges each gap with Pi's own mechanisms
 * (`inbound.ts`, `conversation.ts`); if Pi changes, a test fails and the bridge is revisited
 * (SPEC §6.4). The bridges go when the adapter moves to `pi-durable`.
 */

import { describe, expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { modelsFrom } from "./models.ts";
import { holdTool, scriptedProvider } from "./testing/index.ts";

const ctx = BACKGROUND_CONTEXT;

async function openLane(tools = [] as ReturnType<typeof holdTool>[]) {
  const session = await new MemorySessionRepo().create({}, ctx);
  const models = modelsFrom([scriptedProvider()]);
  const model = models.getModel("faux", "scripted");
  if (model === undefined) throw new Error("faux/scripted missing");
  const { harness } = await AgentHarness.create({ session, models, model, tools }, ctx);
  return { harness, lane: await harness.lane("main", ctx) };
}

describe("Pi gaps (pi-agent-core 0.87.1)", () => {
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
});
