/**
 * deployment-cloudflare's entrypoint in workerd, on real SQLite-backed Durable Objects (SPEC C1, C4,
 * C5): the `Conversation` class and the Worker's `fetch`, over the small Apps of `src/deployment.ts`.
 * `WORKERS_HOST` reaches each App's start, `/health` starts one object's App and reports the version,
 * the object's RPC and alarm reach the handlers its App registered, a failed start resets the object
 * and an evicted one starts again on its next event.
 */

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { JsonValue } from "@pikit/contracts";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { expect, it } from "vitest";
import { createWorkerHost, HEALTH_OBJECT } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import { entrypoint } from "../src/deployment.ts";

/** The object's RPC, as the Worker (and `actor.mailbox`) calls it. */
interface ConversationRpc {
  health(): Promise<{ ok: true }>;
  deliver(type: string, key: string, message: JsonValue): Promise<void>;
}

/** A new object: its stub for the test helpers, and the same stub typed by its RPC. */
function newObject(id = env.CONVERSATION.newUniqueId()) {
  const stub = env.CONVERSATION.get(id);
  return { id, stub, rpc: stub as unknown as ConversationRpc };
}

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
  expect(await stored(stub, "host")).toEqual({ id, variable: "from wrangler vars", bound: true, target: "cloudflare" });
});

it("the Worker's App starts with WORKERS_HOST { env, origin } and serves its http.route", async () => {
  const response = await entrypoint.handler.fetch(new Request("https://lane.example/probe/alice"), env);
  // The origin of the request that started the Worker's App (this test's or /health's: both lane.example).
  expect(await response.json()).toEqual({ variable: "from wrangler vars", origin: "https://lane.example", name: "alice" });
  expect((await entrypoint.handler.fetch(new Request("https://lane.example/nothing"), env)).status).toBe(404);
});

it("deliver() and the alarm reach the handlers the object's App registered, which start it once", async () => {
  const { stub, rpc } = newObject();
  await rpc.deliver("text", "chat:1", { text: "hi" });
  expect(await stored(stub, "delivered")).toEqual(["text", "chat:1", { text: "hi" }]);

  // Set for later and run now: an alarm due now would run on its own, before the test asks.
  await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stored(stub, "alarms")).toBe(1);
  expect(await stored(stub, "starts")).toBe(1);
});

it("an evicted object starts its App again on its next event, from its storage", async () => {
  const { stub, rpc } = newObject();
  await rpc.health();
  await evictDurableObject(stub);
  await rpc.deliver("text", "chat:2", "again");
  expect(await stored(stub, "starts")).toBe(2);
  expect(await stored(stub, "delivered")).toEqual(["text", "chat:2", "again"]);
});

it("a failed start rejects the event and resets the object; the next event starts a new App", async () => {
  const { id, stub, rpc } = newObject();
  await runInDurableObject(stub, (_instance, state) => state.storage.put("fail-start", true));
  const failure = await rpc.deliver("text", "chat:3", null).then(
    () => undefined,
    (error: unknown) => error as Error & { durableObjectReset?: boolean },
  );
  expect(failure?.message).toBe('component "object-probe" failed to start');
  expect(failure?.durableObjectReset).toBe(true);

  const again = newObject(id);
  await runInDurableObject(again.stub, (_instance, state) => state.storage.delete("fail-start"));
  await again.rpc.deliver("text", "chat:3", null);
  expect(await stored(again.stub, "starts")).toBe(1);
});
