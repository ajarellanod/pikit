/**
 * `wakeups.ts` on Bun: a pi-durable Harness over a SQLite file on an injected clock. A closed Harness
 * reopened over the same file is the host evicted and woken again: a task that sleeps stays asleep in
 * the storage, and what `nextWakeAt` reported brings the host back for it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessInspection, SubmissionId, TaskInspection } from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import { openSqliteDatabase } from "./testing/sqlite.ts";
import { driveSlice, nextWakeAt, nextWakeAtOf } from "./wakeups.ts";
import { answerOf, context, fauxAssistantMessage, fauxProvider, liveDueTimes, openClockedHarness, serviceUnavailable, submitInput } from "./testing/wakeups.ts";

const T0 = 1_800_000_000_000;
const RETRY_MS = 60_000;

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
function openDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-wakeups-"));
  directories.push(dir);
  return openSqliteDatabase(join(dir, "pikit.db"), { durableObjectLimits: true });
}

/** A clock the test moves. */
function manualClock(start = T0) {
  let time = start;
  return { now: () => time, set: (to: number) => void (time = to) };
}

describe("nextWakeAtOf: the rules over an inspection", () => {
  const task = (state: TaskInspection["state"]): TaskInspection => ({ record: { kind: "pi.generation" }, state }) as unknown as TaskInspection;
  const of = (...tasks: TaskInspection[]) => nextWakeAtOf({ tasks } as Pick<HarnessInspection, "tasks">, { now: () => T0 });

  test("no live task: undefined", () => expect(of()).toBeUndefined());

  test("a sleeping task is due at its time; the earliest wins", () => {
    expect(of(task({ kind: "sleeping", until: T0 + 5 }))).toBe(T0 + 5);
    expect(of(task({ kind: "sleeping", until: T0 + 9 }), task({ kind: "sleeping", until: T0 + 8 }))).toBe(T0 + 8);
  });

  test("a running or pending task is due now, whatever sleeps", () => {
    expect(of(task({ kind: "running" }), task({ kind: "sleeping", until: T0 + 9 }))).toBe(T0);
    expect(of(task({ kind: "sleeping", until: T0 + 9 }), task({ kind: "pending", migrates: false }))).toBe(T0);
  });

  test("waiting, completing and blocked tasks are never due by themselves", () => {
    expect(of(task({ kind: "waiting", on: [] }), task({ kind: "completing" }), task({ kind: "blocked", reason: "missing_task" } as TaskInspection["state"]))).toBeUndefined();
  });
});

describe("a Harness evicted while it waits", () => {
  test("idle: nothing to wake for, and a slice reports idle at once", async () => {
    const sqlite = openDatabase();
    const clock = manualClock();
    const { harness } = await openClockedHarness(sqlite.database, { now: clock.now, faux: [] });
    try {
      await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
      expect(await nextWakeAt(harness, context, clock)).toBeUndefined();
      expect(await driveSlice(harness, { context, now: clock.now, until: T0 + 10_000 })).toEqual({ idle: true });
    } finally {
      await harness.close(context);
      await sqlite.close();
    }
  });

  test("a model error's retry backoff is the next wake-up; reopened at that time, a slice completes the run", async () => {
    const sqlite = openDatabase();
    const clock = manualClock();
    const settings = { retry: { baseDelayMs: RETRY_MS } };
    const first = await openClockedHarness(sqlite.database, { now: clock.now, faux: [serviceUnavailable()], settings });
    let submissionId!: SubmissionId;
    try {
      submissionId = await submitInput(first.harness, "Capital of France?");
      // The slice runs the request; the error's backoff is after the slice, so it ends there.
      expect(await driveSlice(first.harness, { context, now: clock.now, until: T0 + 10_000 })).toEqual({ idle: false, nextWakeAt: T0 + RETRY_MS });
      expect(await nextWakeAt(first.harness, context, clock)).toBe(T0 + RETRY_MS);
      // pi.live shows the same time.
      expect(await liveDueTimes(first.harness)).toEqual({ retryAt: T0 + RETRY_MS });
      expect(first.faux.state.callCount).toBe(1);
    } finally {
      // Evicted: the sleep's timer dies with it, the sleeping task stays.
      await first.harness.close(context);
    }

    // Woken early (a host's timer may be early on its own clock): nothing runs, the same time is reported.
    clock.set(T0 + RETRY_MS - 1);
    const early = await openClockedHarness(sqlite.database, { now: clock.now, faux: [fauxAssistantMessage("never")], settings });
    try {
      expect(await nextWakeAt(early.harness, context, clock)).toBe(T0 + RETRY_MS);
      expect(await driveSlice(early.harness, { context, now: clock.now })).toEqual({ idle: false, nextWakeAt: T0 + RETRY_MS });
      expect(early.faux.state.callCount).toBe(0);
    } finally {
      await early.harness.close(context);
    }

    clock.set(T0 + RETRY_MS);
    const second = await openClockedHarness(sqlite.database, { now: clock.now, faux: [fauxAssistantMessage("Paris.")], settings });
    try {
      expect(await driveSlice(second.harness, { context, now: clock.now, until: clock.now() + 10_000 })).toEqual({ idle: true });
      expect(await answerOf(second.harness, submissionId)).toEqual({ status: "done", answer: "Paris." });
      expect(await nextWakeAt(second.harness, context, clock)).toBeUndefined();
      expect(await liveDueTimes(second.harness)).toEqual({});
    } finally {
      await second.harness.close(context);
      await sqlite.close();
    }
  });

  test("a backoff that ends within the slice is waited out in it", async () => {
    const sqlite = openDatabase();
    // A clock that runs: the scheduler's in-process timer waits out the 20 ms backoff.
    const start = performance.now();
    const now = () => T0 + Math.floor(performance.now() - start);
    const settings = { retry: { baseDelayMs: 20 } };
    const { harness, faux } = await openClockedHarness(sqlite.database, { now, faux: [serviceUnavailable(), fauxAssistantMessage("Paris.")], settings });
    try {
      const id = await submitInput(harness, "Capital of France?");
      expect(await driveSlice(harness, { context, now, until: now() + 10_000 })).toEqual({ idle: true });
      expect(faux.state.callCount).toBe(2);
      expect((await answerOf(harness, id)).answer).toBe("Paris.");
    } finally {
      await harness.close(context);
      await sqlite.close();
    }
  });

  test("a deferred response's poll time is the next wake-up, after each poll that is still pending", async () => {
    const sqlite = openDatabase();
    const clock = manualClock();
    const settings = { stream: { deferred: true } };
    // The provider keeps the deferred response (as a real one does on its servers): one fetch still pending.
    const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: 30_000 } });
    faux.setResponses([fauxAssistantMessage("Paris.")]);
    const first = await openClockedHarness(sqlite.database, { now: clock.now, faux, settings });
    let id!: SubmissionId;
    try {
      id = await submitInput(first.harness, "Capital of France?");
      expect(await driveSlice(first.harness, { context, now: clock.now })).toEqual({ idle: false, nextWakeAt: T0 + 30_000 });
      expect(await liveDueTimes(first.harness)).toEqual({ pollAt: T0 + 30_000 });
    } finally {
      await first.harness.close(context);
    }
    clock.set(T0 + 30_000);
    const second = await openClockedHarness(sqlite.database, { now: clock.now, faux, settings });
    try {
      // The first poll finds it still pending: the next one is a poll interval later.
      expect(await driveSlice(second.harness, { context, now: clock.now })).toEqual({ idle: false, nextWakeAt: T0 + 60_000 });
      clock.set(T0 + 60_000);
      expect(await driveSlice(second.harness, { context, now: clock.now })).toEqual({ idle: true });
      expect((await answerOf(second.harness, id)).answer).toBe("Paris.");
    } finally {
      await second.harness.close(context);
      await sqlite.close();
    }
  });

  test("a cancelled context ends the slice with the run still going: come back at once", async () => {
    const sqlite = openDatabase();
    const clock = manualClock();
    let started!: () => void;
    const generating = new Promise<void>((resolve) => (started = resolve));
    const hang = async (_transcript: unknown, options?: { signal?: AbortSignal }) => {
      started();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("never seen");
    };
    const { harness } = await openClockedHarness(sqlite.database, { now: clock.now, faux: [hang] });
    try {
      await submitInput(harness, "Count to three");
      const slice = new AbortController();
      void generating.then(() => slice.abort());
      expect(await driveSlice(harness, { context: withAbortSignal(slice.signal, context), now: clock.now })).toEqual({ idle: false, nextWakeAt: T0 });
    } finally {
      await harness.close(context);
      await sqlite.close();
    }
  });
});
