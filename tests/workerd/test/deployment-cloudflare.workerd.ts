/**
 * deployment-cloudflare's entrypoint in workerd, on real SQLite-backed Durable Objects (SPEC C1, C4,
 * C5): the `Conversation` class and the Worker's `fetch`, over the small Apps of `src/deployment.ts`.
 * `WORKERS_HOST` reaches each App's start, `/health` starts one object's App and reports the version,
 * the object's RPC and alarm reach the handlers its App registered, a failed start resets the object
 * and an evicted one starts again on its next event, and an alarm whose start keeps failing leaves
 * its guard alarm, which workerd's own scheduler runs instead of its retries. And actor kinds (SPEC
 * C9): an object of a kind's key runs its kind's App, again from `ctx.id.name` when its alarm wakes it
 * after an eviction; a conversation's runs the whole App; a key that is not the object's is refused.
 */

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { ActorCallOutcome, JsonValue } from "@pikit/contracts";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { expect, it, vi } from "vitest";
import { createHttpRouteConformance } from "@pikit/contracts/testing";
import {
  createWorkerHost,
  createWorkerServer,
  GUARD_FIRST_MS,
  HEALTH_OBJECT,
  OBJECT_KEY,
  START_FAILURES_KEY,
} from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import { entrypoint } from "../src/deployment.ts";

// The Worker's server passes the `http.route` suite in workerd, prefix keys (`GET /admin/*`) included.
for (const c of createHttpRouteConformance(() => {
  const server = createWorkerServer(silentLogger);
  return { components: [server.component], fetch: (path, init) => server.serve(new Request(`https://worker.test${path}`, init)) };
})) {
  it(`Worker server ${c.group}: ${c.name}`, () => c.run());
}

/** The object's RPC, as the Worker (and `actor.mailbox`) calls it. */
interface ConversationRpc {
  health(): Promise<{ ok: true }>;
  deliver(type: string, key: string, message: JsonValue): Promise<void>;
  call(type: string, key: string, message: JsonValue): Promise<ActorCallOutcome>;
}

/** A new object: its stub for the test helpers, and the same stub typed by its RPC. */
function newObject(id = env.CONVERSATION.newUniqueId()) {
  const stub = env.CONVERSATION.get(id);
  return { id, stub, rpc: stub as unknown as ConversationRpc };
}

/** A new object of a key, as actors-do reaches it (`idFromName`): a conversation's by default. */
function objectOf(key = `chat:${crypto.randomUUID()}`) {
  return { key, ...newObject(env.CONVERSATION.idFromName(key)) };
}

/** Why an RPC rejected (read at once: a rejection across the RPC left to `expect` is reported unhandled). */
const refusalOf = (sent: Promise<unknown>) => sent.then(
  () => undefined,
  (error: unknown) => (error as Error).message,
);

/** The whole App, and the App of the kind `owned:` (src/deployment.ts). */
const WHOLE = ["object-probe", "probe-owner", "probe-conversation"];
const OWNED = ["object-probe", "probe-owner"];

/** What the object's storage holds under `key`. */
const stored = (stub: DurableObjectStub, key: string) => runInDurableObject(stub, (_instance, state) => state.storage.get(key));

it("a readiness deadline never publishes a stopped Worker App, and the next request retries cleanly", async () => {
  let apps = 0;
  const component = defineComponent({
    name: "ready-deadline",
    setup(pikit) {
      const first = ++apps === 1;
      let up = false;
      pikit.on("runtime.ready", () => first ? new Promise<void>(() => {}) : undefined);
      pikit.provideKeyed("http.route", "GET /up", () => Response.json({ up }));
      return { start: () => { up = true; }, stop: () => { up = false; } };
    },
  });
  const host = createWorkerHost(defineApp({ components: [component] }), { logger: silentLogger, startDeadlineMs: 200, rollbackDeadlineMs: 200 });
  const first = await host.fetch(new Request("https://lane.example/up"), { ...env });
  expect(first.status).toBe(503);
  const retry = await host.fetch(new Request("https://lane.example/up"), { ...env });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ up: true });
  expect(apps).toBe(2);
});

it("GET /health starts the health object's App, with the object in WORKERS_HOST, and answers { ok, version }", async () => {
  const response = await entrypoint.handler.fetch(new Request("https://lane.example/health"), env);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; version: unknown };
  expect(body.ok).toBe(true);
  expect(body.version).toBe(env.CF_VERSION_METADATA.id);

  const { stub } = newObject(env.CONVERSATION.idFromName(HEALTH_OBJECT));
  const id = await runInDurableObject(stub, (_instance, state) => state.id.toString());
  expect(await stored(stub, "host")).toEqual({ id, variable: "from wrangler vars", bound: true, target: "durable" });
});

it("the Worker's App starts with WORKERS_HOST { env, origin } and serves its http.route", async () => {
  const response = await entrypoint.handler.fetch(new Request("https://lane.example/probe/alice"), env);
  // The origin of the request that started the Worker's App (this test's or /health's: both lane.example).
  expect(await response.json()).toEqual({ variable: "from wrangler vars", origin: "https://lane.example", name: "alice" });
  expect((await entrypoint.handler.fetch(new Request("https://lane.example/nothing"), env)).status).toBe(404);
});

it("deliver() and the alarm reach the handlers the object's App registered, which start it once", async () => {
  const { key, stub, rpc } = objectOf();
  await rpc.deliver("text", key, { text: "hi" });
  expect(await stored(stub, "delivered")).toEqual(["text", key, { text: "hi" }]);

  // Set for later and run now: an alarm due now would run on its own, before the test asks.
  await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stored(stub, "alarms")).toBe(1);
  expect(await stored(stub, "starts")).toBe(1);
});

it("an evicted object starts its App again on its next event, from its storage", async () => {
  const { key, stub, rpc } = objectOf();
  await rpc.health();
  await evictDurableObject(stub);
  await rpc.deliver("text", key, "again");
  expect(await stored(stub, "starts")).toBe(2);
  expect(await stored(stub, "delivered")).toEqual(["text", key, "again"]);
});

it("a failed start rejects the event and resets the object; the next event starts a new App", async () => {
  const { key, id, stub, rpc } = objectOf();
  await runInDurableObject(stub, (_instance, state) => state.storage.put("fail-start", true));
  const failure = await rpc.deliver("text", key, null).then(
    () => undefined,
    (error: unknown) => error as Error & { durableObjectReset?: boolean },
  );
  expect(failure?.message).toBe('component "object-probe" failed to start');
  expect(failure?.durableObjectReset).toBe(true);

  const again = newObject(id);
  await runInDurableObject(again.stub, (_instance, state) => state.storage.delete("fail-start"));
  await again.rpc.deliver("text", key, null);
  expect(await stored(again.stub, "starts")).toBe(1);
});

it("an alarm whose start keeps failing is not dropped: its retry sets the guard alarm, which replaces workerd's retries; once the App starts, the alarm's work runs", async () => {
  const { id } = newObject();
  // A new stub for each step: a failed start resets the object.
  const inside = <T>(callback: (state: DurableObjectState) => Promise<T>) => runInDurableObject(env.CONVERSATION.get(id), (_instance, state) => callback(state));
  await inside((state) => state.storage.put("fail-start", true));
  try {
    // Due now: workerd's own scheduler fires it, its start fails, and it retries it about 2 s later.
    const before = Date.now();
    await inside((state) => state.storage.setAlarm(before));
    const guard = await vi.waitFor(
      async () => {
        const [failures, alarm] = await inside(async (state) => [await state.storage.get(START_FAILURES_KEY), await state.storage.getAlarm()] as const);
        // The retry counted its failed start and set the guard, half a minute later.
        expect(failures).toBe(1);
        expect(alarm).toBeGreaterThan(before + GUARD_FIRST_MS);
        return alarm as number;
      },
      { timeout: 15_000, interval: 250 },
    );
    // No retry runs before the guard: the retry would have counted another failed start.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await inside((state) => state.storage.get(START_FAILURES_KEY))).toBe(1);
    expect(await inside((state) => state.storage.getAlarm())).toBe(guard);

    // The start works again: the guard (fired here, not waited for) starts the App, and its alarm runs.
    await inside((state) => state.storage.delete("fail-start"));
    expect(await runDurableObjectAlarm(env.CONVERSATION.get(id))).toBe(true);
    expect(await inside((state) => state.storage.get("alarms"))).toBe(1);
    expect(await inside((state) => state.storage.get(START_FAILURES_KEY))).toBeUndefined();
  } finally {
    await inside(async (state) => {
      await state.storage.delete("fail-start");
      await state.storage.deleteAlarm();
    });
  }
});

it("an object of a kind's key runs its kind's App; a conversation's, the whole App; the platform names each object", async () => {
  const owned = objectOf(`owned:${crypto.randomUUID()}`);
  expect(await owned.rpc.call("probe.app", owned.key, null)).toEqual({ ok: true, answer: OWNED });
  // workerd gives the object its name (ctx.id.name): nothing kept for its alarm.
  await runInDurableObject(owned.stub, async (_instance, state) => {
    expect(state.id.name).toBe(owned.key);
    expect(await state.storage.get(OBJECT_KEY)).toBeUndefined();
  });
  const chat = objectOf();
  expect(await chat.rpc.call("probe.app", chat.key, null)).toEqual({ ok: true, answer: WHOLE });
  // A call the kind's App has no answer for says which kind the object runs.
  const missing = await owned.rpc.call("memory.list", owned.key, null);
  expect(missing).toEqual({ ok: false, code: "no_handler", message: expect.stringContaining('this object runs the actor kind "owned:": object-probe, probe-owner, not the whole App') });
});

it("a kind's object evicted and woken by its alarm composes its kind's App again, from ctx.id.name", async () => {
  const owned = objectOf(`owned:${crypto.randomUUID()}`);
  await owned.rpc.health();
  expect(await stored(owned.stub, "app")).toEqual(OWNED);
  await evictDurableObject(owned.stub);
  await runInDurableObject(owned.stub, (_instance, state) => state.storage.put("app", null));
  await evictDurableObject(owned.stub);
  // Set for later and run now: the alarm constructs the object again, which knows only its id.
  await runInDurableObject(owned.stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
  await evictDurableObject(owned.stub);
  expect(await runDurableObjectAlarm(owned.stub)).toBe(true);
  expect(await stored(owned.stub, "app")).toEqual(OWNED);
  expect(await stored(owned.stub, "alarms")).toBe(1);
});

it("an event whose key is not the object's is refused before anything starts: it never chooses an App", async () => {
  const owned = objectOf(`owned:${crypto.randomUUID()}`);
  expect(await owned.rpc.call("probe.app", "chat:somebody", null)).toEqual({ ok: false, code: "invalid", message: expect.stringContaining("its key is not this object's name: refused") });
  expect(await refusalOf(owned.rpc.deliver("text", "owned:another", null))).toMatch(/its key is not this object's name/);
  expect(await stored(owned.stub, "starts")).toBeUndefined();
  // An object the platform gives no name (a unique id) refuses every key: none is its own.
  const unnamed = newObject();
  expect(await refusalOf(unnamed.rpc.deliver("text", "chat:1", null))).toMatch(/its key names another object/);
});
