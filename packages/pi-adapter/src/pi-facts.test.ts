/**
 * Facts about pi-agent-core 0.87.1 that the adapter relies on (SPEC §6.4). Asserted on Pi
 * directly, so a Pi bump that changes one fails here before it breaks the adapter.
 */

import { describe, expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, type JsonValue, MemorySessionRepo, value } from "@earendil-works/pi-agent-core";
import { modelsFrom } from "./models.ts";
import { scriptedProvider } from "./testing/index.ts";

const ctx = BACKGROUND_CONTEXT;

function scripted() {
  const models = modelsFrom([scriptedProvider()]);
  const model = models.getModel("faux", "scripted");
  if (model === undefined) throw new Error("faux/scripted missing");
  return { models, model };
}

describe("Pi facts (pi-agent-core 0.87.1)", () => {
  test("AgentHarness.close() closes the session it was given; the next owner reopens it from the repo", async () => {
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, ctx);
    const { harness } = await AgentHarness.create({ session, ...scripted() }, ctx);
    await (await harness.lane("main", ctx)).prompt("hello", undefined, ctx);

    await harness.close(ctx);

    await expect(session.getStats(ctx)).rejects.toThrow();
    const reopened = await repo.open(session.metadata, ctx);
    expect((await reopened.getStats(ctx)).messageCount).toBe(2);
    await reopened.close(ctx);
  });

  test("session values survive a new harness and start empty in a new session (agent.state, SPEC §6.2a)", async () => {
    const STATE = value<JsonValue>("pikit", "agent.state");
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, ctx);
    const first = await AgentHarness.create({ session, ...scripted() }, ctx);
    await session.setValue(STATE, { phase: "deploying" }, ctx);
    await first.harness.close(ctx);

    // Eviction is not a reset: the same stored session has the value.
    const reopened = await repo.open(session.metadata, ctx);
    expect((await reopened.getValue(STATE, ctx))?.value).toEqual({ phase: "deploying" });
    await reopened.close(ctx);

    // A reset is a new session (SPEC §7.6): nothing carries over.
    const fresh = await repo.create({}, ctx);
    expect(await fresh.getValue(STATE, ctx)).toBeUndefined();
    await fresh.close(ctx);
  });

  test("a branch scan honours start and stopAtId newestFirst, and includes the stop entry", async () => {
    const session = await new MemorySessionRepo().create({}, ctx);
    const { harness } = await AgentHarness.create({ session, ...scripted() }, ctx);
    const lane = await harness.lane("main", ctx);
    await lane.prompt("one", undefined, ctx);
    const second = await lane.prompt("two", undefined, ctx);
    if (!second.ok || !("tipId" in second.value)) throw new Error("second run did not settle");
    const { fromTipId, tipId } = second.value;
    if (fromTipId === null || tipId === null) throw new Error("expected both tips");

    const newest = await lane.findEntries({ start: tipId, stopAtId: fromTipId, order: "newestFirst" }, ctx);
    const oldest = await lane.findEntries({ start: tipId, stopAtId: fromTipId, order: "oldestFirst" }, ctx);

    expect(newest.map((entry) => entry.id).at(-1)).toBe(fromTipId);
    expect(newest).toHaveLength(3);
    // oldestFirst walks from the root instead: the adapter reads a run newestFirst and reverses.
    expect(oldest.map((entry) => entry.id)).not.toEqual([...newest].reverse().map((entry) => entry.id));
    await harness.close(ctx);
  });
});
