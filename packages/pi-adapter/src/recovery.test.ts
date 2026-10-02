/**
 * The durable runtime across workers (a new app over the same SQLite file) and with
 * `agent.submissions` (the old submissions.test.ts scenarios): what it records and when, a run a
 * closed worker left open resumed by the next one, a run that ended while nobody recorded it settled
 * from pi-durable, requests nothing can answer abandoned, and work that only waits for a time.
 */

import { afterEach, expect, test } from "bun:test";
import type { AgentSubmissions } from "@pikit/contracts";
import { createMemorySubmissions } from "@pikit/contracts/testing";
import { databaseFile, openWorker, releasableHold, scriptedAgent, scriptedProvider, type Worker } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A database file for the test, and a way to open workers over it (each closed after the test unless closed before). */
function records() {
  const file = databaseFile();
  cleanup.push(file.dispose);
  return {
    async worker(options: Parameters<typeof openWorker>[1] = {}): Promise<Worker> {
      const w = await openWorker(file.path, options);
      cleanup.push(w.close);
      return w;
    },
  };
}

test("a message is recorded before dispatch resolves, and its run's end before agent.settled", async () => {
  const { submissions } = createMemorySubmissions();
  const calls: string[] = [];
  const watched: AgentSubmissions = {
    ...submissions,
    admitted: (conversation, requestId, ctx) => (calls.push(`admitted ${requestId}`), submissions.admitted(conversation, requestId, ctx)),
    settled: (run, ctx) => (calls.push(`settled ${run.requestIds.join(",")}`), submissions.settled(run, ctx)),
  };
  const w = await records().worker({ submissions: watched });
  const conversation = await w.conversation();
  const seenAtEvent: (string | undefined)[] = [];
  // Where agent.submissions says the request is when its result arrives.
  const result = w.result("r1").then(async (r) => seenAtEvent.push((await submissions.get(conversation, r.requestId, w.ctx))?.kind));

  await w.dispatch("r1", "hello", conversation);
  calls.push("dispatch resolved");
  await result;

  expect(calls.indexOf("admitted r1")).toBeLessThan(calls.indexOf("dispatch resolved"));
  expect(calls).toContain("settled r1");
  expect(seenAtEvent).toEqual(["settled"]);
  const { items } = await submissions.answers.read(undefined, 10);
  expect(items.map((i) => i.fact)).toEqual([{ conversation, requestId: "r1", requestIds: ["r1"], kind: "completed", text: "answer: hello" }]);
});

test("a queued message is settled by its own run; one abort() withdrew is settled aborted, unannounced", async () => {
  const { submissions } = createMemorySubmissions();
  const hold = releasableHold();
  const w = await records().worker({ submissions, agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;
  await w.dispatch("r2", "change course", conversation);
  await w.dispatch("r3", "never mind", conversation);

  await w.runtime.abort(conversation, w.ctx);
  await w.result("r1");
  await w.runtime.whenIdle(w.ctx);

  const settled = async (requestId: string) => {
    const status = await submissions.get(conversation, requestId, w.ctx);
    return status?.kind === "settled" ? [status.run.kind, status.run.requestIds] : status?.kind;
  };
  expect([await settled("r1"), await settled("r2"), await settled("r3")]).toEqual([
    ["aborted", ["r1"]],
    ["aborted", ["r2"]],
    ["aborted", ["r3"]],
  ]);
  expect(await submissions.pending(w.ctx)).toEqual([]);
  expect(w.results().map((r) => r.requestId)).toEqual(["r1"]);
});

test("a run a closed worker left open: the next one resumes it (agent.started resumed), records and announces its end", async () => {
  const { submissions } = createMemorySubmissions();
  const db = records();
  const hold = releasableHold();
  const first = await db.worker({ submissions, agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.dispatch("r1", "hold", conversation);
  await hold.started;
  await first.close();
  expect((await submissions.get(conversation, "r1", first.ctx))?.kind).toBe("pending");

  // The tool is not replay-safe: the model gets it as interrupted, and the run answers.
  const again = releasableHold();
  const next = await db.worker({ submissions, agents: [scriptedAgent([again.tool as never])] });
  await next.runtime.recover(conversation, ["r1"], next.ctx);

  expect((await submissions.get(conversation, "r1", next.ctx))?.kind).toBe("settled");
  expect(await next.started("r1")).toEqual({ conversation, requestId: "r1", resumed: true });
  const result = await next.result("r1");
  expect(result.kind).toBe("completed");
  expect(again.calls()).toBe(0);
  expect(JSON.stringify(result.messages.find((message) => message.role === "toolResult"))).toContain("interrupted");
  expect(await submissions.pending(next.ctx)).toEqual([]);
});

test("replay: safe — the interrupted tool runs again in the next worker, resumed by resume()", async () => {
  const db = records();
  const hold = releasableHold("safe");
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.dispatch("r1", "hold", conversation);
  await hold.started;
  await first.close();

  const again = releasableHold("safe");
  again.release();
  const next = await db.worker({ agents: [scriptedAgent([again.tool as never])] });
  await next.runtime.resume(conversation, next.ctx);

  expect((await next.result("r1")).kind).toBe("completed");
  expect(again.calls()).toBe(1);
});

test("after a worker died, a redelivery is a duplicate, and a new message is queued behind the resumed run", async () => {
  const db = records();
  const hold = releasableHold();
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.dispatch("r1", "hold", conversation);
  await hold.started;
  await first.close();

  const again = releasableHold("safe");
  const next = await db.worker({ agents: [scriptedAgent([again.tool as never])] });
  expect(await next.dispatch("r1", "hold", conversation)).toEqual({ kind: "duplicate", requestId: "r1" });
  expect(await next.dispatch("r2", "after the crash", conversation)).toEqual({ kind: "queued", requestId: "r2" });

  expect((await next.result("r1")).kind).toBe("completed");
  expect((await next.result("r2")).text).toBe("answer: after the crash");
});

test("recover settles, from pi-durable, a run whose end was never recorded, and announces it once", async () => {
  const { submissions } = createMemorySubmissions();
  const db = records();
  // The first worker: its run ended in pi-durable, and it never recorded it.
  const first = await db.worker();
  const conversation = await first.conversation();
  await submissions.admitted(conversation, "r1", first.ctx);
  await first.dispatch("r1", "hello", conversation);
  await first.result("r1");
  await first.close();

  const next = await db.worker({ submissions });
  await next.runtime.recover(conversation, ["r1"], next.ctx);

  const status = await submissions.get(conversation, "r1", next.ctx);
  expect(status?.kind === "settled" && status.run.text).toBe("answer: hello");
  expect((await next.result("r1")).text).toBe("answer: hello");
  // Recovering again: recorded already, nothing is recorded or announced twice.
  await next.runtime.recover(conversation, ["r1"], next.ctx);
  await next.runtime.whenIdle(next.ctx);
  expect((await submissions.answers.read(undefined, 10)).items).toHaveLength(1);
  expect(next.results()).toHaveLength(1);
});

test("recover settles a run that took two queued messages, whose end was never recorded, as one result", async () => {
  const { submissions } = createMemorySubmissions();
  const db = records();
  const hold = releasableHold();
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.dispatch("r1", "hold", conversation);
  await hold.started;
  await first.dispatch("r2", "one", conversation);
  await first.dispatch("r3", "two", conversation);
  for (const requestId of ["r2", "r3"]) await submissions.admitted(conversation, requestId, first.ctx);
  hold.release();
  await first.result("r2");
  await first.close();

  const next = await db.worker({ submissions, agents: [scriptedAgent([hold.tool as never])] });
  await next.runtime.recover(conversation, ["r2", "r3"], next.ctx);

  const result = await next.result("r2");
  expect([result.text, result.requestIds]).toEqual(["answer: two", ["r2", "r3"]]);
  expect(next.results()).toHaveLength(1);
  expect(await submissions.pending(next.ctx)).toEqual([]);
});

test("a request admitted before the move to pi-durable (a Pi 0.99 session id) is settled aborted, never abandoned or announced", async () => {
  const { submissions } = createMemorySubmissions();
  const w = await records().worker({ submissions });
  const conversation = { key: "test:legacy", agent: "scripted", conversationId: "0199a1b2-legacy-session" };
  await submissions.admitted(conversation, "r-old", w.ctx);

  await w.runtime.recover(conversation, ["r-old"], w.ctx);

  const status = await submissions.get(conversation, "r-old", w.ctx);
  expect(status?.kind === "settled" && [status.run.kind, status.run.requestIds]).toEqual(["aborted", ["r-old"]]);
  expect(await submissions.pending(w.ctx)).toEqual([]);
  expect(w.results()).toEqual([]);
});

test("suspend closes the Harness and keeps the runtime: the next call reopens it, and a run waiting for a retry continues", async () => {
  const db = records();
  let calls = 0;
  const overloaded = () => (calls++ === 0 ? Promise.resolve("overloaded") : undefined);
  let clock = Date.now();
  const w = await db.worker({
    providers: [scriptedProvider({ fail: overloaded })],
    runtime: { now: () => clock, settings: { retry: { baseDelayMs: 600_000, maxAgentDelayMs: 600_000 } }, onIdleWithPendingWork: async () => {} },
  });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hello", conversation);
  while (calls === 0) await Bun.sleep(1);
  expect(await w.runtime.whenIdle(w.ctx)).toBe(true);

  await w.runtime.suspend(w.ctx);
  expect(w.runtime.holds(conversation)).toBe(false);
  clock += 3_600_000;
  // Reopened by the next call: the run's retry is due on the Harness clock, and it answers. Its start
  // was announced before the suspend, and is not announced again.
  await w.runtime.resume(conversation, w.ctx);
  expect((await w.result("r1")).text).toBe("answer: hello");
  expect(w.events.filter((e) => e.name === "agent.started")).toHaveLength(1);
});

test("a redelivery of a request pi-durable ran but agent.submissions never heard of settles it", async () => {
  const { submissions } = createMemorySubmissions();
  const db = records();
  const first = await db.worker();
  const conversation = await first.conversation();
  await first.dispatch("r1", "hello", conversation);
  await first.result("r1");
  await first.close();

  const next = await db.worker({ submissions });
  expect(await next.dispatch("r1", "hello", conversation)).toEqual({ kind: "duplicate", requestId: "r1" });

  const status = await submissions.get(conversation, "r1", next.ctx);
  expect(status?.kind === "settled" && status.run.text).toBe("answer: hello");
  expect((await next.result("r1")).text).toBe("answer: hello");
  await next.dispatch("r1", "hello", conversation);
  await next.runtime.whenIdle(next.ctx);
  expect((await submissions.answers.read(undefined, 10)).items).toHaveLength(1);
  expect(next.results()).toHaveLength(1);
});

test("recover settles as aborted a request an abort withdrew, when the worker died before recording it", async () => {
  const { submissions } = createMemorySubmissions();
  const db = records();
  const hold = releasableHold();
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.dispatch("a1", "hold", conversation);
  await hold.started;
  await first.dispatch("a2", "never mind", conversation);
  await first.runtime.abort(conversation, first.ctx);
  await first.result("a1");
  await first.close();
  await submissions.admitted(conversation, "a2", first.ctx);

  const next = await db.worker({ submissions });
  await next.runtime.recover(conversation, ["a2"], next.ctx);

  const status = await submissions.get(conversation, "a2", next.ctx);
  expect(status?.kind === "settled" && [status.run.kind, status.run.requestIds]).toEqual(["aborted", ["a2"]]);
  expect(await submissions.pending(next.ctx)).toEqual([]);
  expect(next.results()).toEqual([]);
});

test("a failed admission record fails the dispatch, and the run still ends recorded; a failed end record is tried again", async () => {
  const { submissions } = createMemorySubmissions();
  let failAdmitted = 1;
  let failSettled = 1;
  const flaky: AgentSubmissions = {
    ...submissions,
    async admitted(conversation, requestId, ctx) {
      if (failAdmitted-- > 0) throw new Error("storage failed");
      return submissions.admitted(conversation, requestId, ctx);
    },
    async settled(run, ctx) {
      if (failSettled-- > 0) throw new Error("storage failed");
      return submissions.settled(run, ctx);
    },
  };
  const w = await records().worker({ submissions: flaky });
  const conversation = await w.conversation();

  await expect(w.dispatch("r1", "hello", conversation)).rejects.toThrow("storage failed");
  expect(await w.dispatch("r1", "hello", conversation)).toEqual({ kind: "duplicate", requestId: "r1" });
  expect((await w.result("r1")).text).toBe("answer: hello");

  const deadline = Date.now() + 5_000;
  while ((await submissions.get(conversation, "r1", w.ctx))?.kind !== "settled") {
    if (Date.now() > deadline) throw new Error("the run's end was never recorded");
    await Bun.sleep(50);
  }
}, 10_000);

test("recover does not wait for a run a new message started in the conversation", async () => {
  const { submissions } = createMemorySubmissions();
  const hold = releasableHold();
  const w = await records().worker({ submissions, agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;

  const recovered = w.runtime.recover(conversation, ["r0"], w.ctx).then(() => "recovered");
  expect(await Promise.race([recovered, Bun.sleep(1_000).then(() => "waited for r1")])).toBe("recovered");
  hold.release();
  await w.result("r1");
});

test("recover abandons, and announces, the requests of a conversation whose agent or conversation is gone", async () => {
  const { submissions } = createMemorySubmissions();
  const w = await records().worker({ submissions });
  const removed = { ...(await w.conversation()), agent: "removed" };
  const missing = { key: "test:missing", agent: "scripted", conversationId: "4242" };
  await submissions.admitted(removed, "r1", w.ctx);
  await submissions.admitted(missing, "r2", w.ctx);

  await w.runtime.recover(removed, ["r1"], w.ctx);
  await w.runtime.recover(missing, ["r2"], w.ctx);

  expect([(await w.result("r1")).error, (await w.result("r2")).error]).toEqual([
    { code: "abandoned", message: "agent_removed" },
    { code: "abandoned", message: "conversation_missing" },
  ]);
  expect(await submissions.pending(w.ctx)).toEqual([]);
  await w.runtime.recover(removed, ["r1"], w.ctx);
  expect(w.results()).toHaveLength(2);
});

test("abandon leaves the requests pi-durable still runs", async () => {
  const { submissions } = createMemorySubmissions();
  const hold = releasableHold();
  const w = await records().worker({ submissions, agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;

  await w.runtime.abandon(conversation, ["r1"], "unanswered_too_long", w.ctx);

  expect((await submissions.get(conversation, "r1", w.ctx))?.kind).toBe("pending");
  hold.release();
  expect((await w.result("r1")).kind).toBe("completed");
});

test("a run waiting out a model retry: whenIdle reports it as pending work, and a later worker answers it", async () => {
  const db = records();
  let calls = 0;
  const overloaded = () => (calls++ === 0 ? Promise.resolve("overloaded") : undefined);
  const told: { kind: string; phase: unknown }[] = [];
  const first = await db.worker({
    providers: [scriptedProvider({ fail: overloaded })],
    runtime: {
      settings: { retry: { baseDelayMs: 600_000, maxAgentDelayMs: 600_000 } },
      onIdleWithPendingWork: async (inspection) => {
        for (const task of inspection.tasks) told.push({ kind: task.record.kind, phase: (task.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase });
      },
    },
  });
  const conversation = await first.conversation();
  await first.dispatch("r1", "hello", conversation);
  while (calls === 0) await Bun.sleep(1);

  expect(await first.runtime.whenIdle(first.ctx)).toBe(true);
  expect(told).toEqual([{ kind: "pi.generation", phase: "retry" }]);
  expect(first.results()).toEqual([]);
  await first.close();

  // The next worker's clock is past the retry: it answers.
  const next = await db.worker({ runtime: { now: () => Date.now() + 3_600_000 } });
  await next.runtime.resume(conversation, next.ctx);
  expect((await next.result("r1")).text).toBe("answer: hello");
});
