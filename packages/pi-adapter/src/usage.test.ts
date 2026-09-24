/**
 * `AgentResult.usage`: every run, settled or failed, reports what it cost in Pi's own numbers. The
 * cross-check is Pi's usage ledger: the runs of a session add up to the session's totals.
 */

import { describe, expect, test } from "bun:test";
import { type Entry, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type AgentDefinition, type AppEvents, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createPiRuntime, modelsFrom, type Provider, type SessionStore } from "./index.ts";
import { runUsage } from "./result.ts";
import { holdTool, scriptedAgent, scriptedProvider } from "./testing/index.ts";

const ctx = BACKGROUND_CONTEXT;
type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

async function setup(provider: Provider, agent: AgentDefinition) {
  const sessions: SessionStore = new MemorySessionRepo();
  const results: Result[] = [];
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
    },
  });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => (name === agent.name ? agent : undefined),
    models: modelsFrom([provider]),
    events: app.context(),
  });
  const session = await sessions.create({ cwd: "/" }, ctx);
  await session.close(ctx);
  const conversation = { key: `test:${session.metadata.id}`, agent: agent.name, sessionId: session.metadata.id };
  const result = async (requestId: string): Promise<Result> => {
    for (;;) {
      const found = results.find((candidate) => candidate.requestId === requestId);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  /** Pi's own totals for the session: every row of its usage ledger. */
  const sessionUsage = async (): Promise<Usage> => {
    const metadata = (await sessions.list(undefined, ctx)).find((m: { id: string }) => m.id === conversation.sessionId);
    const opened = await sessions.open(metadata, ctx);
    const { usage } = await opened.getStats(ctx);
    await opened.close(ctx);
    return usage;
  };
  const dispatch = (requestId: string, prompt: string) => runtime.dispatch({ requestId, conversation, prompt }, app.context());
  return { dispatch, result, sessionUsage, close: () => runtime.close(app.context()) };
}

function assistantUsages(result: Result): Usage[] {
  return result.messages.flatMap((message) => (message.role === "assistant" ? [message.usage] : []));
}

describe("usage of a run", () => {
  test("a settled run reports its model calls, tool turn included, and matches Pi's ledger", async () => {
    const s = await setup(scriptedProvider(), scriptedAgent(holdTool(async () => "done")));

    await s.dispatch("r1", "hold");
    const result = await s.result("r1");

    expect(result.kind).toBe("completed");
    // Two model calls: the tool call and the answer after the tool result.
    const calls = assistantUsages(result);
    expect(calls).toHaveLength(2);
    expect(result.usage?.totalTokens).toBe(calls.reduce((sum, usage) => sum + usage.totalTokens, 0));
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.usage).toEqual(await s.sessionUsage());
    await s.close();
  });

  test("the runs of a session add up to its totals: nothing counted twice or missed", async () => {
    const s = await setup(scriptedProvider(), scriptedAgent(holdTool(async () => "done")));

    await s.dispatch("r1", "one");
    const first = await s.result("r1");
    await s.dispatch("r2", "two");
    const second = await s.result("r2");

    const total = await s.sessionUsage();
    expect((first.usage?.input ?? 0) + (second.usage?.input ?? 0)).toBe(total.input);
    expect((first.usage?.output ?? 0) + (second.usage?.output ?? 0)).toBe(total.output);
    expect((first.usage?.cacheRead ?? 0) + (second.usage?.cacheRead ?? 0)).toBe(total.cacheRead);
    expect((first.usage?.totalTokens ?? 0) + (second.usage?.totalTokens ?? 0)).toBe(total.totalTokens);
    // The second run reads the first one's prefix from the provider's cache.
    expect(second.usage?.cacheRead).toBeGreaterThan(0);
    await s.close();
  });

  test("a failed run reports what its failed call cost", async () => {
    const faux = fauxProvider({ models: [{ id: "broken" }] });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "the provider broke" })]);
    const s = await setup(faux.provider, { name: "broken", model: "faux/broken" });

    await s.dispatch("r1", "hello");
    const result = await s.result("r1");

    expect(result.kind).toBe("failed");
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.usage).toEqual(await s.sessionUsage());
    await s.close();
  });
});

describe("runUsage", () => {
  const usage = (tokens: number, cost: number, extra: Partial<Usage> = {}): Usage => ({
    input: tokens,
    output: tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2 * tokens,
    cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0, total: 2 * cost },
    ...extra,
  });
  const base = { parentId: null, seq: 0, timestamp: 0 };
  const assistant = (id: string, u: Usage): Entry =>
    ({
      ...base,
      id,
      type: "message",
      message: { role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: u, stopReason: "stop", timestamp: 0 },
    }) as Entry;

  test("sums Pi's costs and keeps optional fields only when reported", () => {
    const entries: Entry[] = [
      { ...base, id: "in", type: "message", message: { role: "custom", customType: "pikit.inbound", content: "hi", display: true, timestamp: 0 } } as Entry,
      assistant("a1", usage(10, 0.5, { reasoning: 3 })),
      {
        ...base,
        id: "t1",
        type: "message",
        message: { role: "toolResult", toolCallId: "c", toolName: "t", content: [], isError: false, usage: usage(1, 0.25), timestamp: 0 },
      } as Entry,
      { ...base, id: "k1", type: "compaction", summary: "s", retainedTail: [], tokensBefore: 0, usage: usage(2, 1), fromHook: false } as Entry,
      assistant("a2", usage(5, 0.125)),
    ];

    const total = runUsage(entries);

    expect(total).toEqual({
      input: 18,
      output: 18,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 3,
      totalTokens: 36,
      cost: { input: 1.875, output: 1.875, cacheRead: 0, cacheWrite: 0, total: 3.75 },
    });
    expect("cacheWrite1h" in total).toBe(false);
  });

  test("a run that called no model costs zero", () => {
    expect(runUsage([])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
});
