/**
 * `AgentResult.usage` on pi-durable: every run, settled or failed, reports what it cost in pi-ai's
 * numbers. The cross-check is pi-durable's ledger, the conversation's `pi.usage` document: the runs of
 * a conversation add up to it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, UsageDoc } from "@earendil-works/pi-durable";
import type { ConversationRef } from "@pikit/contracts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openSqliteDatabase } from "./testing/sqlite.ts";
import { type DurableMessage, type DurableUsage, runUsage } from "./result.ts";
import { openDurableStorage } from "./sql.ts";
import { databaseFile, openWorker, releasableHold, scriptedAgent } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** pi-durable's ledger of `conversation`, every bucket summed, read by a Harness of its own once the worker closed. */
async function ledger(path: string, conversation: ConversationRef): Promise<DurableUsage> {
  const sqlite = openSqliteDatabase(path);
  const harness = await Harness.open(await openDurableStorage(sqlite.database), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const state = await harness.snapshot(UsageDoc, Number(conversation.conversationId) as never, BACKGROUND_CONTEXT);
    const usages = [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})];
    return runUsage(usages.map((usage) => ({ role: "assistant", usage }) as unknown as DurableMessage));
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await sqlite.close();
  }
}

async function setup(options: Parameters<typeof openWorker>[1] = {}) {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const w = await openWorker(file.path, options);
  cleanup.push(w.close);
  return { ...w, path: file.path };
}

function assistantUsages(result: { messages: unknown[] }): DurableUsage[] {
  return result.messages.flatMap((message) => ((message as { role: string }).role === "assistant" ? [(message as { usage: DurableUsage }).usage] : []));
}

describe("usage of a run", () => {
  test("a settled run reports its model calls, tool turn included, and matches pi-durable's ledger", async () => {
    const hold = releasableHold();
    hold.release();
    const s = await setup({ agents: [scriptedAgent([hold.tool as never])] });
    const conversation = await s.conversation();

    await s.dispatch("r1", "hold", conversation);
    const result = await s.result("r1");
    await s.close();

    expect(result.kind).toBe("completed");
    const calls = assistantUsages(result);
    expect(calls).toHaveLength(2);
    expect(result.usage?.totalTokens).toBe(calls.reduce((sum, usage) => sum + usage.totalTokens, 0));
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.usage as unknown).toEqual(await ledger(s.path, conversation));
  });

  test("the runs of a conversation add up to its ledger: nothing counted twice or missed", async () => {
    const s = await setup();
    const conversation = await s.conversation();

    await s.dispatch("r1", "one", conversation);
    const first = await s.result("r1");
    await s.dispatch("r2", "two", conversation);
    const second = await s.result("r2");
    await s.close();

    const total = await ledger(s.path, conversation);
    expect((first.usage?.input ?? 0) + (second.usage?.input ?? 0)).toBe(total.input);
    expect((first.usage?.output ?? 0) + (second.usage?.output ?? 0)).toBe(total.output);
    expect((first.usage?.totalTokens ?? 0) + (second.usage?.totalTokens ?? 0)).toBe(total.totalTokens);
  });

  test("a failed run reports what its failed call cost", async () => {
    const faux = fauxProvider({ models: [{ id: "broken" }] });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "the provider broke" })]);
    const s = await setup({ agents: [{ name: "broken", model: "faux/broken" }], providers: [faux.provider] });
    const conversation = await s.conversation();

    await s.dispatch("r1", "hello", conversation);
    const result = await s.result("r1");
    await s.close();

    expect([result.kind, result.error]).toEqual(["failed", { code: "model_error", message: "the provider broke" }]);
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.usage as unknown).toEqual(await ledger(s.path, conversation));
  });

});

describe("runUsage", () => {
  const usage = (tokens: number, cost: number, extra: Partial<DurableUsage> = {}): DurableUsage => ({
    input: tokens,
    output: tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2 * tokens,
    cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0, total: 2 * cost },
    ...extra,
  });

  test("sums model responses and tool results, keeping optional fields only when reported", () => {
    const messages = [
      { role: "user", content: "hi", timestamp: 0 },
      { role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: usage(10, 0.5, { reasoning: 3 }), stopReason: "toolUse", timestamp: 0 },
      { role: "toolResult", toolCallId: "c", toolName: "t", content: [], isError: false, usage: usage(1, 0.25), timestamp: 0 },
      { role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: usage(5, 0.125), stopReason: "stop", timestamp: 0 },
    ] as DurableMessage[];

    const total = runUsage(messages);

    expect(total).toEqual({
      input: 16,
      output: 16,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 3,
      totalTokens: 32,
      cost: { input: 0.875, output: 0.875, cacheRead: 0, cacheWrite: 0, total: 1.75 },
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
