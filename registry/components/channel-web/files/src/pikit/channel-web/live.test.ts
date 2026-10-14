/**
 * The live view's projection (`live.ts`) over a watch a test writes event by event: what a user may
 * see of a run, by its inputs' request ids only.
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import type { AgentObserver, ObservedEvent } from "@pikit/contracts";
import type { ChatEvent } from "./api.ts";
import { liveEvents } from "./live.ts";
import type { ChatStore, StoreNote } from "./store.ts";

/** A watch whose events the test pushes, and the store's notes. */
async function view(snapshot: ObservedEvent) {
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

test("FAIL CLOSED: a view opened while an operator-only run goes, the user's message queued, streams nothing of that run; the user's own next run streams", async () => {
  // The operator's run (submission 7, `dashboard:op-1`) is going; the snapshot names its inputs by submission id only.
  const v = await view({
    type: "snapshot",
    entries: [],
    run: { inputs: [7] },
    generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Operator only: the refund was denied because " }] } },
    tools: [{ callId: "c1", name: "crm_lookup", status: "running" }],
    inbox: [{ id: 8, mode: "followUp" }],
  });
  expect(await v.take(1)).toEqual([{ type: "state", busy: true }]);
  // The user's message waits behind it (stored, pending).
  v.store.notify("web:ana:x", { type: "message", id: "web:m1" });
  expect(await v.take(1)).toEqual([{ type: "message", id: "web:m1" }]);
  v.push({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "of fraud flag #A12." }] });
  v.push({ type: "tool_execution_start", toolCallId: "c2", toolName: "internal_admin_tool", args: {} });
  v.push({ type: "tool_execution_end", toolCallId: "c2" });
  // The operator's run ends; the user's starts: its submission first, as the runtime sends it.
  v.push({ type: "run_end", inputs: [7] });
  v.push({ type: "submission", record: { id: 8, requestId: "web:m1" } });
  v.push({ type: "run_start", inputs: [8] });
  v.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } });
  expect(await v.take(3)).toEqual([
    { type: "state", busy: false },
    { type: "state", busy: true },
    { type: "partial", text: "Hi", requests: ["web:m1"] },
  ]);
  expect(JSON.stringify(v.seen)).not.toMatch(/refund|fraud|crm_lookup|internal_admin_tool/);
  await v.end();
});

test("a run of only the operator's follow-up streams nothing even when its request ids are known; a run of both is the user's", async () => {
  const v = await view({ type: "snapshot", entries: [], tools: [] });
  expect(await v.take(1)).toEqual([{ type: "state", busy: false }]);
  v.push({ type: "submission", record: { id: 1, requestId: "dashboard:op-1" } });
  v.push({ type: "run_start", inputs: [1] });
  v.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "operator only" }] } });
  v.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  v.push({ type: "run_end", inputs: [1] });
  v.push({ type: "submission", record: { id: 2, requestId: "dashboard:op-2" } });
  v.push({ type: "submission", record: { id: 3, requestId: "web:m2" } });
  v.push({ type: "run_start", inputs: [2, 3] });
  v.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "both" }] } });
  expect(await v.take(4)).toEqual([
    { type: "state", busy: true },
    { type: "state", busy: false },
    { type: "state", busy: true },
    { type: "partial", text: "both", requests: ["dashboard:op-2", "web:m2"] },
  ]);
  await v.end();
});
