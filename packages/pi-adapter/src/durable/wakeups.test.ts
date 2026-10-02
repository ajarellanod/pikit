/**
 * `wakeups.ts` on Bun: a pi-durable Harness over a SQLite file on an injected clock. A closed Harness
 * reopened over the same file is the host evicted and woken again: whatever slept in-process is gone,
 * only what `nextWakeAt` reported brings it back.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessInspection, SubmissionId, TaskInspection } from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import { openSqliteDatabase } from "../testing/sqlite.ts";
import { driveSlice, nextWakeAt, nextWakeAtOf } from "./wakeups.ts";
import { answerOf, context, fauxAssistantMessage, fauxProvider, liveDueTimes, openClockedHarness, serviceUnavailable, submitInput } from "./wakeups-testing.ts";

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
  const task = (kind: string, state: TaskInspection["state"], checkpoint: unknown, extra: Record<string, unknown> = {}): TaskInspection =>
    ({ record: { kind, state: { status: state.kind === "running" ? "running" : "pending", checkpoint }, ...extra }, state }) as unknown as TaskInspection;
  const ready = { kind: "ready", migrates: false } as const;
  const of = (...tasks: TaskInspection[]) => nextWakeAtOf({ tasks } as Pick<HarnessInspection, "tasks">, { now: () => T0 });

  test("no live task: undefined", () => expect(of()).toBeUndefined());

  test("the built-in waits report their checkpointed time; the earliest wins", () => {
    expect(of(task("pi.generation", ready, { phase: "retry", attempt: 1, until: T0 + 5 }))).toBe(T0 + 5);
    expect(of(task("pi.generation", { kind: "running" }, { phase: "poll", attempt: 1, pollAt: T0 + 7 }))).toBe(T0 + 7);
    expect(of(task("pi.compaction", ready, { phase: "retry", until: T0 + 9 }), task("pi.generation", ready, { phase: "retry", until: T0 + 8 }))).toBe(T0 + 8);
  });

  test("any other ready or running task, or an abort-marked wait, is due now", () => {
    expect(of(task("pi.generation", { kind: "running" }, { phase: "request", attempt: 1 }), task("pi.compaction", ready, { phase: "retry", until: T0 + 9 }))).toBe(T0);
    expect(of(task("my.task", ready, { phase: "sleeping", until: T0 + 9 }))).toBe(T0);
    expect(of(task("pi.generation", ready, { phase: "retry", until: T0 + 9 }, { abortRequested: true }))).toBe(T0);
  });

  test("waiting, completing and blocked tasks are never due by themselves", () => {
    expect(
      of(
        task("pi.generation", { kind: "waiting", on: [] }, { phase: "tools" }),
        task("pi.tool", { kind: "completing" }, undefined),
        task("gone.task", { kind: "blocked", reason: "missing_task" }, { phase: "x" }),
      ),
    ).toBeUndefined();
  });

  test("dueAt reports a custom task's checkpointed time", () => {
    const custom = task("my.task", ready, { phase: "sleeping", until: T0 + 9 });
    const dueAt = (record: TaskInspection["record"]) => (record.kind === "my.task" ? ((record.state as { checkpoint: { until: number } }).checkpoint.until) : undefined);
    expect(nextWakeAtOf({ tasks: [custom] }, { now: () => T0, dueAt })).toBe(T0 + 9);
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
      // Evicted: the in-process sleep dies with it.
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
