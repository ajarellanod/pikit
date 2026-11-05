/**
 * The live view (`live.ts`) over a watch a test writes change by change: which runs and entries are
 * the user's (by the run's request ids only), the user's live value sent whole then as ops, each run's
 * message with the id the transcript gives it. What users see of them is the policy's
 * (`visibility.test.ts`).
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import { type AgentObserver, applyOps, diffOps, type JsonValue, type ObservedEvent, type ObservedLive } from "@pikit/contracts";
import type { ChatEvent, ChatLive } from "./api.ts";
import { runEntryId } from "./entries.ts";
import { liveEvents } from "./live.ts";
import type { ChatStore, StoreNote } from "./store.ts";

const json = (value: unknown): JsonValue => value as JsonValue;

/** A watch whose live value the test sets (`set`, sent as ops) and whose events it pushes, and the store's notes. */
async function view(first: ObservedLive) {
  let deliver: ((event: ObservedEvent | "end") => void) | undefined;
  const queued: (ObservedEvent | "end")[] = [];
  const push = (event: ObservedEvent | "end"): void => {
    if (deliver !== undefined) {
      const waiting = deliver;
      deliver = undefined;
      waiting(event);
    } else queued.push(event);
  };
  let current = first;
  const observe = {
    async *watch() {
      yield { type: "live", ops: [["r", json(first)]] } satisfies ObservedEvent;
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
  /** The user's live value, as a view folds the `live` events seen. */
  let shown: JsonValue = null;
  return {
    push,
    store,
    seen,
    shown: () => shown as unknown as ChatLive,
    /** The runtime's live value becomes `next`: sent as the ops from the last one. */
    set(next: ObservedLive): void {
      push({ type: "live", ops: diffOps(json(current), json(next)) });
      current = next;
    },
    /** Reads until `count` events came. */
    async take(count: number): Promise<ChatEvent[]> {
      const taken: ChatEvent[] = [];
      while (taken.length < count) {
        const next = await events.next();
        if (next.done === true) break;
        taken.push(next.value);
        seen.push(next.value);
        if (next.value.type === "live") shown = applyOps(shown, next.value.ops as never);
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
const IDLE: ObservedLive = { busy: false, tools: [] };

test("FAIL CLOSED: a view opened while an operator-only run goes, the user's message waiting, shows nothing of that run but that it goes; the user's own next run streams", async () => {
  const operator: ObservedLive = {
    busy: true,
    requests: ["dashboard:op-1"],
    partial: json({ role: "assistant", content: [{ type: "text", text: "Operator only: the refund was denied because " }] }),
    tools: [{ callId: "c1", name: "crm_lookup", status: "running" }],
  };
  const v = await view(operator);
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["r", { busy: true, tools: [] }]] }]);
  // An entry of the user's, now in the transcript.
  const mine = { id: "web:m1", kind: "message" as const, messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 3 }] };
  v.store.notify("web:ana:x", { type: "entry", entry: mine });
  expect(await v.take(1)).toEqual([{ type: "entries", entries: [mine] }]);
  v.set({ ...operator, partial: json(answer("Operator only: the refund was denied because of fraud flag #A12.")) });
  v.set({ ...operator, tools: [{ callId: "c2", name: "internal_admin_tool", status: "running" }] });
  v.push({ type: "entries", entries: [{ id: "2", kind: "message", messages: [json(answer("Operator only: refund"))] }] });
  // The operator's run fails; the user's starts.
  v.set({ busy: false, tools: [], failure: { reason: "model_error", detail: "operator secret" } });
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["s", ["busy"], false]] }]);
  v.set({ busy: true, requests: ["web:m1"], partial: json({ role: "assistant", content: [{ type: "text", text: "Hi" }] }), tools: [] });
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["s", ["busy"], true], ["s", ["partial"], { role: "assistant", content: [{ type: "text", text: "Hi" }] }]] }]);
  // Something stored changed: read the transcript again.
  v.store.notify("web:ana:x", { type: "changed" });
  expect(await v.take(1)).toEqual([{ type: "transcript" }]);
  expect(JSON.stringify(v.seen)).not.toMatch(/refund|fraud|crm_lookup|internal_admin_tool|operator secret|model_error/);
  await v.end();
});

test("a view opened mid-run of the user's: its answer, its tools (call id, name, status, output only); a streamed answer costs its new text; the run's end and its failure", async () => {
  const going: ObservedLive = {
    busy: true,
    requests: ["web:first"],
    partial: json({ role: "assistant", content: [{ type: "text", text: "Hel" }] }),
    tools: [{ callId: "t1", name: "websearch", status: "running", output: "found", taskId: 9 } as never],
  };
  const v = await view(going);
  expect(await v.take(1)).toEqual([
    { type: "live", ops: [["r", { busy: true, partial: { role: "assistant", content: [{ type: "text", text: "Hel" }] }, tools: [{ callId: "t1", name: "websearch", status: "running", output: "found" }] }]] },
  ]);
  v.set({ ...going, partial: json({ role: "assistant", content: [{ type: "text", text: "Hello" }] }) });
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["a", ["partial", "content", 0, "text"], "lo"]] }]);
  v.set({ busy: false, tools: [], failure: { reason: "model_error", detail: "the provider said 500" } });
  await v.take(1);
  expect(v.shown()).toEqual({ busy: false, tools: [], failure: { reason: "model_error" } });
  // The next run starts: the failure is gone.
  v.set({ busy: true, requests: ["web:second"], tools: [] });
  await v.take(1);
  expect(v.shown()).toEqual({ busy: true, tools: [] });
  expect(JSON.stringify(v.seen)).not.toMatch(/provider said|taskId/);
  await v.end();
});

test("FAIL CLOSED: a failure the view never saw the run of (it opened after, or the run went past unseen) is not shown", async () => {
  const v = await view({ busy: false, tools: [], failure: { reason: "model_error" } });
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["r", { busy: false, tools: [] }]] }]);
  // The user's run fails, seen: shown.
  v.set({ busy: true, requests: ["web:m1"], tools: [] });
  await v.take(1);
  v.set({ busy: false, tools: [], failure: { reason: "turn_limit" } });
  await v.take(1);
  expect(v.shown()).toEqual({ busy: false, tools: [], failure: { reason: "turn_limit" } });
  // An operator's run went past unseen (the watch folded it): its failure is not the user's.
  v.set({ busy: false, tools: [], failure: { reason: "aborted" } });
  await v.take(1);
  expect(v.shown()).toEqual({ busy: false, tools: [] });
  await v.end();
});

test("a run of only the operator's follow-ups shows nothing but that it goes; a run of both is the user's; changes queued behind each other are folded into one event", async () => {
  const v = await view(IDLE);
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["r", { busy: false, tools: [] }]] }]);
  v.set({ busy: true, requests: ["dashboard:op-1"], partial: json(answer("operator only")), tools: [{ callId: "t1", name: "bash", status: "running" }] });
  v.set(IDLE);
  v.set({ busy: true, requests: ["dashboard:op-2", "web:m2"], partial: json(answer("both")), tools: [] });
  // Read after all three came: one event, the newest state.
  await Bun.sleep(20);
  const [folded] = await v.take(1);
  expect(folded).toEqual({ type: "live", ops: [["s", ["busy"], true], ["s", ["partial"], answer("both")]] });
  expect(JSON.stringify(v.seen)).not.toMatch(/operator only|bash/);
  await v.end();
});

test("STABLE IDS: a run's message comes with the id the transcript gives it (its run's first request, its hash); the runtime's user and system messages and the entries of a run not the user's never pass", async () => {
  const run: ObservedLive = { busy: true, requests: ["dashboard:op-1", "web:m1"], tools: [] };
  const v = await view(run);
  await v.take(1);
  const call = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "websearch", arguments: {} }], stopReason: "toolUse", timestamp: 4 };
  const result = { role: "toolResult", toolCallId: "t1", toolName: "websearch", content: [{ type: "text", text: "found" }], isError: false, timestamp: 5 };
  v.push({
    type: "entries",
    entries: [
      // The inputs as the runtime holds them (an operator's follow-up among them): never the user's to see.
      { id: "10", kind: "message", messages: [{ role: "user", content: "[From the operator] secret" }] },
      { id: "11", kind: "message", messages: [json(call)] },
      { id: "12", kind: "message", messages: [json(result)] },
      { id: "13", kind: "pi.reset", messages: [] },
      { id: "14", kind: "message", messages: [{ role: "system", content: "secret system prompt" }, json(answer("Done"))] },
    ],
  });
  const [entries] = await v.take(1);
  v.set(IDLE);
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["s", ["busy"], false]] }]);
  // An operator's run after it: its entries never pass, nor the runtime's hints.
  v.set({ busy: true, requests: ["dashboard:op-2"], tools: [] });
  expect(await v.take(1)).toEqual([{ type: "live", ops: [["s", ["busy"], true]] }]);
  v.push({ type: "entries", entries: [{ id: "15", kind: "message", messages: [json(answer("secret operator answer"))] }] });
  v.push({ type: "usage" });
  v.push({ type: "transcript" });
  await Bun.sleep(20);
  v.store.notify("web:ana:x", { type: "changed" });
  expect(await v.take(1)).toEqual([{ type: "transcript" }]);
  expect(entries).toEqual(
    {
      type: "entries",
      entries: [
        { id: runEntryId("dashboard:op-1", call), kind: "message", messages: [call] },
        { id: runEntryId("dashboard:op-1", result), kind: "message", messages: [result] },
        { id: runEntryId("dashboard:op-1", answer("Done")), kind: "message", messages: [answer("Done")] },
      ],
    },
  );
  expect(JSON.stringify(v.seen)).not.toMatch(/secret/);
  // The same message (any field order) has the same id; another, another.
  expect(runEntryId("web:m1", { timestamp: 5, content: [{ text: "Done", type: "text" }], role: "assistant" })).toBe(runEntryId("web:m1", answer("Done")));
  expect(runEntryId("web:m1", answer("Done"))).not.toBe(runEntryId("web:m1", answer("Done!")));
  expect(runEntryId("web:m1", answer("Done"))).not.toBe(runEntryId("web:m2", answer("Done")));
  expect(runEntryId("web:m1", answer("Done"))).toMatch(/^web:m1#[0-9a-f]{14}$/);
  await v.end();
});

test("ops that do not apply end the view with their error; a conversation with no runtime conversation yet is idle", async () => {
  const v = await view(IDLE);
  await v.take(1);
  v.push({ type: "live", ops: [["a", ["partial", "content"], "x"]] });
  const failed = v.take(1);
  // This watch ignores its cancellation (the runtime's ends with it): it ends so the view is released.
  await Bun.sleep(10);
  v.push("end");
  await expect(failed).rejects.toThrow("json-ops");

  const app = await defineApp({ components: [], logger: silentLogger }).create();
  const store = { subscribe: () => () => {} } as unknown as ChatStore;
  const none = liveEvents({ observe: {} as AgentObserver, store, key: "web:ana:y", conversationId: undefined }, app.context());
  expect((await none.next()).value).toEqual({ type: "live", ops: [["r", { busy: false, tools: [] }]] });
  await none.return(undefined);
});
