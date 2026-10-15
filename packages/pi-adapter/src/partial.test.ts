/**
 * `agent.partial`: the answer as the model writes it, re-emitted from pi-durable's live state
 * (`pi.live`'s `generation.message`) while the run goes, throttled, and never after the run's end.
 */

import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { databaseFile, openWorker } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** About 400 characters, streamed 4 at a time, 200 chunks a second: half a second of writing. */
const ANSWER = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");

test("agent.partial carries the answer as written so far while the run streams, throttled, and none comes after the run settled", async () => {
  const slow = fauxProvider({ provider: "slow", models: [{ id: "model" }], tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
  slow.setResponses([fauxAssistantMessage(ANSWER)]);
  const file = databaseFile();
  cleanup.push(file.dispose);
  const w = await openWorker(file.path, {
    agents: [{ name: "slow", model: "slow/model" }],
    providers: [slow.provider],
    partials: true,
    runtime: { partialEveryMs: 60, settings: { progress: { partialIntervalMs: 10 } } },
  });
  cleanup.push(w.close);
  const conversation = await w.conversation();

  await w.dispatch("r1", "write a long answer", conversation);
  const result = await w.result("r1");
  expect(result.text).toBe(ANSWER);
  // Whatever was still on its way when the run ended had time to arrive.
  await Bun.sleep(200);

  const names = w.events.map((event) => event.name);
  const partials = w.events.flatMap((event) => (event.name === "agent.partial" ? [event.payload] : []));
  expect(partials.length).toBeGreaterThanOrEqual(2);
  // While the run went: after its start, before its end.
  expect(names.indexOf("agent.partial")).toBeGreaterThan(names.indexOf("agent.started"));
  expect(names.lastIndexOf("agent.partial")).toBeLessThan(names.indexOf("agent.settled"));
  for (const [index, payload] of partials.entries()) {
    expect(payload.requestId).toBe("r1");
    expect(payload.conversation.conversationId).toBe(conversation.conversationId);
    // The answer so far: it only grows.
    expect(ANSWER.startsWith(payload.text)).toBe(true);
    if (index > 0) expect(payload.text.length).toBeGreaterThan((partials[index - 1] as { text: string }).text.length);
  }
  // Throttled: fewer than pi-durable's commits (one per 10 ms over about half a second).
  expect(partials.length).toBeLessThan(20);
});
