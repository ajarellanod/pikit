/**
 * Characterisation of what pi-agent-core 0.87.1 does NOT do for pikit. These tests assert
 * today's behaviour on purpose: when Pi closes a gap, its test fails, and the adapter drops
 * whatever it does around it (SPEC §6.4, "Gaps found by the spike"). pikit builds no substitute.
 */

import { describe, expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { scriptedModel } from "./fixtures.ts";

const ctx = BACKGROUND_CONTEXT;

async function openLane() {
  const session = await new MemorySessionRepo().create({}, ctx);
  const { harness } = await AgentHarness.create({ session, ...scriptedModel() }, ctx);
  return { harness, lane: await harness.lane("main", ctx) };
}

describe("Pi gaps (pi-agent-core 0.87.1)", () => {
  test("accept() does not reject a reused operationId: the same request runs twice", async () => {
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

  test("a steer that lands after the run's last boundary waits for the next run", async () => {
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
});
