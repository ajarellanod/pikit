/**
 * What a host that keeps running only while an event is in progress needs from the runtime (SPEC §4.1,
 * C4): to know when this worker drives nothing (`whenIdle`, `holds`), and to continue a run past Pi's
 * retry backoff itself (`retryAt`), instead of a timer in a process that may be gone by then.
 */

import { expect, test } from "bun:test";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { type AppEvents, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withCancel } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import { createPiRuntime, modelsFrom, type SessionStore } from "./index.ts";
import { holdTool, scriptedAgent, scriptedProvider } from "./testing/index.ts";

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

/**
 * A runtime whose first model call fails with a provider error Pi retries (a 503), and whose `hold`
 * tool waits for `release`. With `retryAt`, the retry waits it is told of are recorded.
 */
async function setup(options: { retryAt?: boolean; failFirst?: boolean } = {}) {
  const sessions: SessionStore = new MemorySessionRepo();
  const results: Result[] = [];
  const waiters = new Set<() => void>();
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const record = (result: Result) => {
        results.push(result);
        for (const wake of waiters) wake();
      };
      pikit.on("agent.settled", record);
      pikit.on("agent.failed", record);
    },
  });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const agent = scriptedAgent(holdTool(() => released.then(() => "released")));
  let failed = !options.failFirst;
  const provider = scriptedProvider({
    fail: () => {
      if (failed) return undefined;
      failed = true;
      return Promise.resolve("503 service unavailable");
    },
  });
  const retries: { conversation: ConversationRef; notBefore: number; at: number }[] = [];
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => (name === agent.name ? agent : undefined),
    models: modelsFrom([provider]),
    events: app.context(),
    ...(options.retryAt && { retryAt: async (conversation, notBefore) => void retries.push({ conversation, notBefore, at: Date.now() }) }),
  });
  const session = await sessions.create({ cwd: "/" }, BACKGROUND_CONTEXT);
  await session.close(BACKGROUND_CONTEXT);
  const conversation = { key: `test:${session.metadata.id}`, agent: agent.name, sessionId: session.metadata.id };
  const result = (requestId: string) =>
    new Promise<Result>((resolve) => {
      const check = () => {
        const found = results.find((r) => r.requestId === requestId);
        if (found === undefined) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  return { app, runtime, conversation, results, retries, release, result };
}

test("whenIdle resolves true once no run is driven, and false when its context is cancelled first", async () => {
  const s = await setup();
  const ctx = s.app.context();
  expect(await s.runtime.whenIdle(ctx)).toBe(true);

  await s.runtime.dispatch({ requestId: "r1", conversation: s.conversation, prompt: "hold" }, ctx);
  expect(s.runtime.holds(s.conversation)).toBe(true);
  const slice = withCancel(BACKGROUND_CONTEXT);
  const cut = s.runtime.whenIdle(s.app.context(slice.context));
  slice.cancel(new Error("the slice ended"));
  expect(await cut).toBe(false);

  const idle = s.runtime.whenIdle(ctx);
  s.release();
  expect(await idle).toBe(true);
  expect(s.results.map((r) => [r.requestId, r.kind])).toEqual([["r1", "completed"]]);
  expect(s.runtime.holds(s.conversation)).toBe(false);

  await s.runtime.close(ctx);
  expect(await s.runtime.whenIdle(ctx)).toBe(false);
});

test("without retryAt, Pi's retry backoff is waited in this process and the run answers", async () => {
  const s = await setup({ failFirst: true });
  const ctx = s.app.context();

  await s.runtime.dispatch({ requestId: "r1", conversation: s.conversation, prompt: "hello" }, ctx);

  expect(s.runtime.holds(s.conversation)).toBe(true);
  expect(await s.runtime.whenIdle(ctx)).toBe(true);
  const result = await s.result("r1");
  expect([result.kind, result.text]).toEqual(["completed", "answer: hello"]);
  await s.runtime.close(ctx);
}, 10_000);

test("with retryAt, a run at Pi's retry backoff stops being driven, stays open, and resuming it after notBefore answers", async () => {
  const s = await setup({ retryAt: true, failFirst: true });
  const ctx = s.app.context();
  const before = Date.now();

  await s.runtime.dispatch({ requestId: "r1", conversation: s.conversation, prompt: "hello" }, ctx);
  expect(await s.runtime.whenIdle(ctx)).toBe(true);

  // Told when the retry is due (Pi's first wait is 1 s), and nothing is driven meanwhile.
  expect(s.retries).toHaveLength(1);
  const [retry] = s.retries;
  expect(retry?.conversation).toMatchObject(s.conversation);
  expect(retry?.notBefore).toBeGreaterThanOrEqual(before + 1_000);
  expect(retry?.notBefore).toBeLessThanOrEqual(Date.now() + 1_000);
  expect(s.runtime.holds(s.conversation)).toBe(false);
  expect(s.results).toEqual([]);

  // Resumed early, it waits again and says so; resumed once due, the run answers.
  await s.runtime.resume(s.conversation, ctx);
  expect(await s.runtime.whenIdle(ctx)).toBe(true);
  expect(s.retries).toHaveLength(2);
  expect(s.retries[1]?.notBefore).toBe(retry?.notBefore as number);
  await Bun.sleep(Math.max(0, (retry?.notBefore ?? 0) - Date.now()));
  await s.runtime.resume(s.conversation, ctx);
  expect(await s.runtime.whenIdle(ctx)).toBe(true);
  const result = await s.result("r1");
  expect([result.kind, result.text]).toEqual(["completed", "answer: hello"]);
  expect(s.retries).toHaveLength(2);
  await s.runtime.close(ctx);
}, 10_000);

test("with retryAt, a run aborted while it waits for its retry reports its end", async () => {
  const s = await setup({ retryAt: true, failFirst: true });
  const ctx = s.app.context();
  await s.runtime.dispatch({ requestId: "r1", conversation: s.conversation, prompt: "hello" }, ctx);
  expect(await s.runtime.whenIdle(ctx)).toBe(true);

  await s.runtime.abort(s.conversation, ctx);

  const result = await s.result("r1");
  expect(result.kind).toBe("aborted");
  expect(await s.runtime.whenIdle(ctx)).toBe(true);
  await s.runtime.close(ctx);
}, 10_000);
