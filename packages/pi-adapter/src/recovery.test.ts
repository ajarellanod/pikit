/**
 * The durable runtime across workers (a new app over the same SQLite file) and its
 * `agent.submissions`, read from pi-durable: the answers log written once per run, a run a closed
 * worker left open resumed by the next one, a run whose log a crash never wrote logged once by the
 * next reconciliation (a redelivery, a start), requests nothing can answer abandoned, retention, and
 * work that only waits for a time.
 */

import { afterEach, expect, test } from "bun:test";
import type { ConversationRef, RunSettlement, SqlDatabase, SqlValue } from "@pikit/contracts";
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

/**
 * `storage.sql` whose answers-log appends fail while `crashing(params)` holds: the run is settled in
 * pi-durable and its log never written, as when the process dies between the two.
 */
function crashingLog(crashing: (params: readonly SqlValue[]) => boolean) {
  return (db: SqlDatabase): SqlDatabase => ({
    query: (sql, params) => db.query(sql, params),
    run: (sql, params) => db.run(sql, params),
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: (sql, params) => tx.query(sql, params),
          run: (sql, params) =>
            sql.includes("INSERT INTO runtime_pi_answers") && crashing(params ?? []) ? Promise.reject(new Error("the process died")) : tx.run(sql, params),
        }),
      ),
  });
}

/** Whether an append's parameters are a run that took `requestId`. */
const takes = (requestId: string) => (params: readonly SqlValue[]) => typeof params[5] === "string" && (JSON.parse(params[5]) as string[]).includes(requestId);

const answers = async (w: Worker): Promise<RunSettlement[]> => (await w.runtime.submissions.answers.read(undefined, 100)).items.map((item) => item.fact);

/** Waits until pi-durable holds `requestId` settled (its log may not be written). */
async function settledInDurable(w: Worker, conversation: ConversationRef, requestId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await w.runtime.submissions.get(conversation, requestId, w.ctx))?.kind !== "settled") {
    if (Date.now() > deadline) throw new Error(`${requestId} never settled`);
    await Bun.sleep(10);
  }
}

test("a run is logged in answers before agent.settled, and get says where a request is", async () => {
  const w = await records().worker();
  const conversation = await w.conversation();
  const seenAtEvent: unknown[] = [];
  const result = w.result("r1").then(async (r) => seenAtEvent.push((await w.runtime.submissions.get(conversation, r.requestId, w.ctx))?.kind, (await answers(w)).length));

  await w.dispatch("r1", "hello", conversation);
  await result;

  expect(seenAtEvent).toEqual(["settled", 1]);
  expect(await answers(w)).toEqual([{ conversation, requestId: "r1", requestIds: ["r1"], kind: "completed", text: "answer: hello" }]);
  expect(await w.runtime.submissions.get(conversation, "unknown", w.ctx)).toBeUndefined();
  expect(await w.runtime.submissions.get({ conversationId: "4242" }, "r1", w.ctx)).toBeUndefined();
  expect(await w.runtime.submissions.pending(w.ctx)).toEqual([]);
});

test("pending: pi-durable's queued and placed requests, by conversation, the oldest first, with their admission time", async () => {
  let clock = 1_000_000;
  const hold = releasableHold();
  const w = await records().worker({ agents: [scriptedAgent([hold.tool as never])], runtime: { now: () => clock } });
  const first = await w.conversation();
  const second = await w.conversation();
  await w.dispatch("a1", "hold", first);
  await hold.started;
  clock += 10;
  await w.dispatch("b1", "hold", second);
  clock += 10;
  await w.dispatch("a2", "queued", first);

  const pending = await w.runtime.submissions.pending(w.ctx);

  expect(pending).toEqual([
    { conversation: first, requestIds: ["a1", "a2"], oldestAdmittedAt: 1_000_000 },
    { conversation: second, requestIds: ["b1"], oldestAdmittedAt: 1_000_010 },
  ]);
  expect(await w.runtime.submissions.get(first, "a2", w.ctx)).toEqual({ kind: "pending", conversation: first, requestId: "a2" });
  hold.release();
  await w.result("a2");
  await w.result("b1");
  await w.runtime.whenIdle(w.ctx);
  expect(await w.runtime.submissions.pending(w.ctx)).toEqual([]);
});

test("a queued message is settled by its own run; one abort() withdrew is logged aborted, unannounced", async () => {
  const hold = releasableHold();
  const w = await records().worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;
  await w.dispatch("r2", "change course", conversation);
  await w.dispatch("r3", "never mind", conversation);

  await w.runtime.abort(conversation, w.ctx);
  await w.result("r1");
  await w.runtime.whenIdle(w.ctx);

  const settled = async (requestId: string) => {
    const status = await w.runtime.submissions.get(conversation, requestId, w.ctx);
    return status?.kind === "settled" ? [status.run.kind, status.run.requestIds] : status?.kind;
  };
  expect([await settled("r1"), await settled("r2"), await settled("r3")]).toEqual([
    ["aborted", ["r1"]],
    ["aborted", ["r2"]],
    ["aborted", ["r3"]],
  ]);
  expect((await answers(w)).map((run) => [run.kind, run.requestIds]).sort()).toEqual([
    ["aborted", ["r1"]],
    ["aborted", ["r2"]],
    ["aborted", ["r3"]],
  ]);
  expect(await w.runtime.submissions.pending(w.ctx)).toEqual([]);
  expect(w.results().map((r) => r.requestId)).toEqual(["r1"]);
});

test("a run a closed worker left open: the next one resumes it (agent.started resumed), logs and announces its end", async () => {
  const db = records();
  const hold = releasableHold();
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.dispatch("r1", "hold", conversation);
  await hold.started;
  expect((await first.runtime.submissions.pending(first.ctx)).map((p) => p.requestIds)).toEqual([["r1"]]);
  await first.close();

  // The tool is not replay-safe: the model gets it as interrupted, and the run answers.
  const again = releasableHold();
  const next = await db.worker({ agents: [scriptedAgent([again.tool as never])] });
  await next.runtime.recover(conversation, ["r1"], next.ctx);

  expect((await next.runtime.submissions.get(conversation, "r1", next.ctx))?.kind).toBe("settled");
  expect(await next.started("r1")).toEqual({ conversation, requestId: "r1", resumed: true });
  const result = await next.result("r1");
  expect(result.kind).toBe("completed");
  expect(again.calls()).toBe(0);
  expect(JSON.stringify(result.messages.find((message) => message.role === "toolResult"))).toContain("interrupted");
  expect(await next.runtime.submissions.pending(next.ctx)).toEqual([]);
  expect((await answers(next)).map((run) => run.requestIds)).toEqual([["r1"]]);
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

test("a batch answered together whose log a crash never wrote: a redelivery of one of its messages logs and announces the whole batch, once", async () => {
  let crashing = true;
  const hold = releasableHold();
  const w = await records().worker({ agents: [scriptedAgent([hold.tool as never])], db: crashingLog((params) => crashing && takes("m2")(params)) });
  const conversation = await w.conversation();
  await w.dispatch("m0", "hold", conversation);
  await hold.started;
  for (const [requestId, prompt] of [
    ["m1", "one"],
    ["m2", "two"],
    ["m3", "three"],
  ] as const) {
    expect(await w.dispatch(requestId, prompt, conversation)).toEqual({ kind: "queued", requestId });
  }
  hold.release();
  await w.result("m0");
  // [m1, m2, m3] are answered by one run, settled in pi-durable; its log is never written.
  await settledInDurable(w, conversation, "m3");
  await w.runtime.whenIdle(w.ctx);
  expect((await answers(w)).map((run) => run.requestIds)).toEqual([["m0"]]);
  expect(w.results().map((r) => r.requestIds)).toEqual([["m0"]]);
  crashing = false;

  expect(await w.dispatch("m2", "two", conversation)).toEqual({ kind: "duplicate", requestId: "m2" });
  await w.runtime.whenIdle(w.ctx);

  expect((await answers(w)).map((run) => [run.requestId, run.requestIds, run.text])).toEqual([
    ["m0", ["m0"], "answer: hold"],
    ["m1", ["m1", "m2", "m3"], "answer: three"],
  ]);
  expect(w.results().map((r) => [r.kind, r.requestIds])).toEqual([
    ["completed", ["m0"]],
    ["completed", ["m1", "m2", "m3"]],
  ]);
  const status = await w.runtime.submissions.get(conversation, "m3", w.ctx);
  expect(status?.kind === "settled" && status.run.requestIds).toEqual(["m1", "m2", "m3"]);

  // Delivered again: nothing new.
  expect(await w.dispatch("m2", "two", conversation)).toEqual({ kind: "duplicate", requestId: "m2" });
  expect(await w.dispatch("m1", "one", conversation)).toEqual({ kind: "duplicate", requestId: "m1" });
  await w.runtime.whenIdle(w.ctx);
  expect(await answers(w)).toHaveLength(2);
  expect(w.results()).toHaveLength(2);
});

test("runs settled while their log could not be written are logged once at the next start, in the order they ended", async () => {
  const db = records();
  const first = await db.worker({ db: crashingLog((params) => takes("r1")(params) || takes("r2")(params)) });
  const conversation = await first.conversation();
  await first.dispatch("r0", "zero", conversation);
  await first.result("r0");
  await first.dispatch("r1", "one", conversation);
  await settledInDurable(first, conversation, "r1");
  await first.dispatch("r2", "two", conversation);
  await settledInDurable(first, conversation, "r2");
  await first.runtime.whenIdle(first.ctx);
  expect((await answers(first)).map((run) => run.requestId)).toEqual(["r0"]);
  await first.close();

  const next = await db.worker();
  // Opening reconciles what a crash left unlogged.
  await next.runtime.inspect(next.ctx);
  await next.result("r2");
  await next.runtime.whenIdle(next.ctx);

  expect((await answers(next)).map((run) => [run.requestId, run.text])).toEqual([
    ["r0", "answer: zero"],
    ["r1", "answer: one"],
    ["r2", "answer: two"],
  ]);
  expect(next.results().map((r) => r.requestId)).toEqual(["r1", "r2"]);

  // Another start, and a redelivery: nothing is logged or announced again.
  await next.close();
  const third = await db.worker();
  expect(await third.dispatch("r1", "one", conversation)).toEqual({ kind: "duplicate", requestId: "r1" });
  await third.runtime.whenIdle(third.ctx);
  expect(await answers(third)).toHaveLength(3);
  expect(third.results()).toEqual([]);
});

test("recover logs, as aborted and unannounced, a request an abort withdrew whose log a crash never wrote", async () => {
  const db = records();
  const hold = releasableHold();
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])], db: crashingLog(takes("a2")) });
  const conversation = await first.conversation();
  await first.dispatch("a1", "hold", conversation);
  await hold.started;
  await first.dispatch("a2", "never mind", conversation);
  await first.runtime.abort(conversation, first.ctx);
  await settledInDurable(first, conversation, "a1");
  await settledInDurable(first, conversation, "a2");
  await first.runtime.whenIdle(first.ctx);
  await first.close();

  const next = await db.worker();
  await next.runtime.recover(conversation, ["a2"], next.ctx);
  await next.runtime.whenIdle(next.ctx);

  const status = await next.runtime.submissions.get(conversation, "a2", next.ctx);
  expect(status?.kind === "settled" && [status.run.kind, status.run.requestIds]).toEqual(["aborted", ["a2"]]);
  expect((await answers(next)).map((run) => [run.kind, run.requestIds])).toEqual([
    ["aborted", ["a1"]],
    ["aborted", ["a2"]],
  ]);
  expect(next.results().filter((r) => r.requestIds.includes("a2"))).toEqual([]);
});

test("answers keeps a run keepSettledDays: pruned after, a reader behind is told (gap), and a pruned run is never logged again", async () => {
  const day = 24 * 60 * 60 * 1_000;
  let clock = Date.now();
  const db = records();
  const w = await db.worker({ runtime: { now: () => clock, keepSettledDays: 1 } });
  const conversation = await w.conversation();
  await w.dispatch("r1", "one", conversation);
  await w.result("r1");
  const [logged] = (await w.runtime.submissions.answers.read(undefined, 10)).items;

  clock += 2 * day;
  await w.dispatch("r2", "two", conversation);
  await w.result("r2");
  await w.runtime.whenIdle(w.ctx);

  expect((await answers(w)).map((run) => run.requestId)).toEqual(["r2"]);
  const behind = await w.runtime.submissions.answers.read("0", 10);
  expect([behind.gap, behind.items.map((item) => item.fact.requestId)]).toEqual([true, ["r2"]]);
  expect((await w.runtime.submissions.answers.read(logged?.cursor, 10)).gap).toBe(false);
  // Its own settlement, from pi-durable, once the log no longer has it.
  const status = await w.runtime.submissions.get(conversation, "r1", w.ctx);
  expect(status?.kind === "settled" && [status.run.text, status.run.requestIds]).toEqual(["answer: one", ["r1"]]);

  // A redelivery, and a restart, reconcile the conversation: r1 is not logged again.
  expect(await w.dispatch("r1", "one", conversation)).toEqual({ kind: "duplicate", requestId: "r1" });
  await w.runtime.whenIdle(w.ctx);
  await w.close();
  const next = await db.worker({ runtime: { now: () => clock, keepSettledDays: 1 } });
  await next.runtime.recover(conversation, [], next.ctx);
  await next.runtime.whenIdle(next.ctx);
  expect((await answers(next)).map((run) => run.requestId)).toEqual(["r2"]);
  expect(next.results()).toEqual([]);
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

test("recover does not wait for a run a new message started in the conversation", async () => {
  const hold = releasableHold();
  const w = await records().worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;

  const recovered = w.runtime.recover(conversation, ["r0"], w.ctx).then(() => "recovered");
  expect(await Promise.race([recovered, Bun.sleep(1_000).then(() => "waited for r1")])).toBe("recovered");
  hold.release();
  await w.result("r1");
});

test("abandon settles the queued requests unanswered, logs and announces them as one failure, and leaves the one a run took", async () => {
  const hold = releasableHold();
  const w = await records().worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;
  await w.dispatch("r2", "two", conversation);
  await w.dispatch("r3", "three", conversation);

  await w.runtime.abandon(conversation, ["r1", "r2", "r3", "unknown"], "unanswered_too_long", w.ctx);

  const failed = await w.result("r2");
  expect([failed.kind, failed.requestIds, failed.error]).toEqual(["failed", ["r2", "r3"], { code: "abandoned", message: "unanswered_too_long" }]);
  expect(await answers(w)).toEqual([
    { conversation, requestId: "r2", requestIds: ["r2", "r3"], kind: "failed", error: { code: "abandoned", message: "unanswered_too_long" } },
  ]);
  expect((await w.runtime.submissions.pending(w.ctx)).map((p) => p.requestIds)).toEqual([["r1"]]);
  // Abandoning again changes nothing; the run still answers its own request.
  expect(await w.runtime.submissions.abandoned(conversation, ["r2", "r3"], "unanswered_too_long", w.ctx)).toBeUndefined();
  hold.release();
  expect((await w.result("r1")).kind).toBe("completed");
  await w.runtime.whenIdle(w.ctx);
  expect(w.results()).toHaveLength(2);
});

test("recover abandons the queued requests of a conversation whose agent is gone; an unknown conversation has nothing to abandon", async () => {
  const hold = releasableHold();
  const w = await records().worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await w.conversation();
  await w.dispatch("r1", "hold", conversation);
  await hold.started;
  await w.dispatch("r2", "two", conversation);

  await w.runtime.recover({ ...conversation, agent: "removed" }, ["r2"], w.ctx);
  await w.runtime.recover({ key: "test:missing", agent: "scripted", conversationId: "4242" }, ["r9"], w.ctx);

  expect((await w.result("r2")).error).toEqual({ code: "abandoned", message: "agent_removed" });
  hold.release();
  await w.result("r1");
  await w.runtime.whenIdle(w.ctx);
  expect(w.results().map((r) => r.requestId)).toEqual(["r2", "r1"]);
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
