/**
 * The live view (`live.ts`) over a watch a test writes event by event: which runs and entries are the
 * user's (by its inputs' request ids only), in the dashboard's event shapes, each run's message with
 * the id the transcript gives it. What users see of them is the policy's (`visibility.test.ts`).
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import type { AgentObserver, ObservedEvent } from "@pikit/contracts";
import type { ChatEvent } from "./api.ts";
import { runEntryId } from "./entries.ts";
import { liveEvents } from "./live.ts";
import type { ChatStore, StoreNote } from "./store.ts";

/** A watch whose events the test pushes, and the store's notes. */
async function view(snapshot: ObservedEvent, startedBy?: string) {
  let deliver: ((event: ObservedEvent | "end") => void) | undefined;
  const queued: (ObservedEvent | "end")[] = [];
  const push = (event: ObservedEvent | "end"): void => {
    if (deliver !== undefined) {
      const waiting = deliver;
      deliver = undefined;
      waiting(event);
    } else queued.push(event);
  };
  const observe = {
    async *watch() {
      yield snapshot;
      for (;;) {
        const next = queued.shift() ?? (await new Promise<ObservedEvent | "end">((resolve) => (deliver = resolve)));
        if (next === "end") return;
        yield next;
      }
    },
  } as unknown as AgentObserver;
  const listeners = new Set<(note: StoreNote) => void>();
  const store = {
    subscribe: (_key: string, listener: (note: StoreNote) => void) => (listeners.add(listener), () => listeners.delete(listener)),
    notify: (_key: string, note: StoreNote) => {
      for (const listener of listeners) listener(note);
    },
    // The request that started the run going, as `agent.started` told the App (`index.ts`).
    startedBy: (conversationId: string) => (conversationId === "c1" ? startedBy : undefined),
  } as unknown as ChatStore;
  const app = await defineApp({ components: [], logger: silentLogger }).create();
  const events = liveEvents({ observe, store, key: "web:ana:x", conversationId: "c1" }, app.context());
  const seen: ChatEvent[] = [];
  return {
    push,
    store,
    seen,
    /** Reads until `count` events came. */
    async take(count: number): Promise<ChatEvent[]> {
      const taken: ChatEvent[] = [];
      while (taken.length < count) {
        const next = await events.next();
        if (next.done === true) break;
        taken.push(next.value);
        seen.push(next.value);
      }
      return taken;
    },
    end: async () => {
      push("end");
      await events.return(undefined);
    },
  };
}

const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 5 });

test("FAIL CLOSED: a view opened while an operator-only run goes, the user's message waiting, shows nothing of that run but that it goes; the user's own next run streams", async () => {
  // The operator's run (submission 7, `dashboard:op-1`) is going; the snapshot names its inputs by submission id only.
  const v = await view({
    type: "snapshot",
    entries: [{ id: 1, kind: "message", model: [{ role: "user", content: "operator secret" }] }],
    run: { inputs: [7] },
    generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Operator only: the refund was denied because " }] } },
    tools: [{ callId: "c1", name: "crm_lookup", status: "running" }],
    inbox: [{ id: 8, mode: "followUp" }],
    usage: { models: {} },
  });
  expect(await v.take(1)).toEqual([{ type: "snapshot", run: {}, tools: [] }]);
  // An entry of the user's, now in the transcript.
  const mine = { id: "web:m1", kind: "message" as const, messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 3 }] };
  v.store.notify("web:ana:x", { type: "entry", entry: mine });
  expect(await v.take(1)).toEqual([{ type: "entry_appended", entry: { id: "web:m1", kind: "message", model: mine.messages } }]);
  v.push({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "of fraud flag #A12." }] });
  v.push({ type: "tool_execution_start", toolCallId: "c2", toolName: "internal_admin_tool", args: {} });
  v.push({ type: "tool_execution_end", toolCallId: "c2", toolName: "internal_admin_tool" });
  v.push({ type: "message_end", entry: { id: 2, kind: "message", model: [answer("Operator only: refund")] } });
  // The operator's run ends; the user's starts: its submission first, as the runtime sends it.
  v.push({ type: "run_end", inputs: [7] });
  v.push({ type: "submission", record: { id: 8, requestId: "web:m1" } });
  v.push({ type: "run_start", inputs: [8] });
  v.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } });
  expect(await v.take(3)).toEqual([{ type: "run_end" }, { type: "run_start" }, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }]);
  // Something stored changed: read the transcript again.
  v.store.notify("web:ana:x", { type: "changed" });
  expect(await v.take(1)).toEqual([{ type: "entry_appended" }]);
  expect(JSON.stringify(v.seen)).not.toMatch(/refund|fraud|crm_lookup|internal_admin_tool|operator secret/);
  await v.end();
});

test("a view opened mid-run streams the run the user's message started (the page opens it after the first message), named by agent.started", async () => {
  const v = await view(
    {
      type: "snapshot",
      entries: [],
      run: { inputs: [3] },
      generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } },
      tools: [{ callId: "t1", name: "websearch", status: "running", output: "found", taskId: 9 }],
    },
    "web:first",
  );
  expect(await v.take(1)).toEqual([
    { type: "snapshot", run: {}, generation: { message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } }, tools: [{ callId: "t1", name: "websearch", status: "running", output: "found" }] },
  ]);
  v.push({ type: "message_update", usage: { cost: 1 }, changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] });
  expect(await v.take(1)).toEqual([{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] }]);
  await v.end();
});

test("FAIL CLOSED: a view opened mid-run of a run the operator started streams nothing of it, even with the start heard", async () => {
  const v = await view(
    {
      type: "snapshot",
      entries: [],
      run: { inputs: [7] },
      generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Operator only: secret plan" }] } },
      tools: [{ callId: "c1", name: "crm_lookup", status: "running" }],
    },
    "dashboard:op-1",
  );
  expect(await v.take(1)).toEqual([{ type: "snapshot", run: {}, tools: [] }]);
  v.push({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: " more" }] });
  v.push({ type: "message_end", entry: { id: 4, kind: "message", model: [answer("secret plan")] } });
  v.push({ type: "run_end", inputs: [7] });
  expect(await v.take(1)).toEqual([{ type: "run_end" }]);
  expect(JSON.stringify(v.seen)).not.toMatch(/secret|crm_lookup/);
  await v.end();
});

test("a run of only the operator's follow-up streams nothing even when its request ids are known; a run of both is the user's", async () => {
  const v = await view({ type: "snapshot", entries: [], tools: [] });
  expect(await v.take(1)).toEqual([{ type: "snapshot", tools: [] }]);
  v.push({ type: "submission", record: { id: 1, requestId: "dashboard:op-1" } });
  v.push({ type: "run_start", inputs: [1] });
  v.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "operator only" }] } });
  v.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  v.push({ type: "run_end", inputs: [1] });
  v.push({ type: "submission", record: { id: 2, requestId: "dashboard:op-2" } });
  v.push({ type: "submission", record: { id: 3, requestId: "web:m2" } });
  v.push({ type: "run_start", inputs: [2, 3] });
  v.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "both" }] } });
  expect(await v.take(4)).toEqual([{ type: "run_start" }, { type: "run_end" }, { type: "run_start" }, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "both" }] } }]);
  await v.end();
});

test("STABLE IDS: a run's message ends with the id the transcript gives it (its run's first request, its hash); the runtime's user and system messages and its own entries never pass", async () => {
  const v = await view({ type: "snapshot", entries: [], tools: [] });
  await v.take(1);
  v.push({ type: "submission", record: { id: 1, requestId: "dashboard:op-1" } });
  v.push({ type: "submission", record: { id: 2, requestId: "web:m1" } });
  v.push({ type: "run_start", inputs: [1, 2] });
  // The inputs as the runtime holds them (an operator's follow-up among them): never the user's to see.
  v.push({ type: "message_start", message: { role: "user", content: "[From the operator] secret" } });
  v.push({ type: "message_end", entry: { id: 10, kind: "pi.user", model: [{ role: "user", content: "[From the operator] secret" }] } });
  const call = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "websearch", arguments: {} }], stopReason: "toolUse", timestamp: 4 };
  const result = { role: "toolResult", toolCallId: "t1", toolName: "websearch", content: [{ type: "text", text: "found" }], isError: false, timestamp: 5 };
  v.push({ type: "message_end", entry: { id: 11, kind: "message", model: [call] } });
  v.push({ type: "tool_execution_end", toolCallId: "t1", toolName: "websearch", entry: { id: 12, kind: "message", model: [result] } });
  v.push({ type: "message_start", message: result });
  v.push({ type: "message_end", entry: { id: 12, kind: "message", model: [result] } });
  v.push({ type: "entry_appended", entry: { id: 13, kind: "pi.reset", data: { secret: true } } });
  v.push({ type: "message_end", entry: { id: 14, kind: "message", model: [{ role: "system", content: "secret system prompt" }, answer("Done")] } });
  v.push({ type: "run_end", inputs: [1, 2] });
  expect(await v.take(6)).toEqual([
    { type: "run_start" },
    { type: "message_end" },
    { type: "message_end", entry: { id: runEntryId("dashboard:op-1", call), kind: "message", model: [call] } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "websearch" },
    { type: "message_end", entry: { id: runEntryId("dashboard:op-1", result), kind: "message", model: [result] } },
    { type: "message_end", entry: { id: runEntryId("dashboard:op-1", answer("Done")), kind: "message", model: [answer("Done")] } },
  ]);
  expect(JSON.stringify(v.seen)).not.toMatch(/secret/);
  // The same message (any field order) has the same id; another, another.
  expect(runEntryId("web:m1", { timestamp: 5, content: [{ text: "Done", type: "text" }], role: "assistant" })).toBe(runEntryId("web:m1", answer("Done")));
  expect(runEntryId("web:m1", answer("Done"))).not.toBe(runEntryId("web:m1", answer("Done!")));
  expect(runEntryId("web:m1", answer("Done"))).not.toBe(runEntryId("web:m2", answer("Done")));
  expect(runEntryId("web:m1", answer("Done"))).toMatch(/^web:m1#[0-9a-f]{14}$/);
  await v.end();
});
