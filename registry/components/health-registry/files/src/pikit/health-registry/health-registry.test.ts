/**
 * health-registry's tests. They are copied with the component and keep running in your project.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, type Handle, type KeyedHandle, silentLogger } from "@pikit/core";
import type { AdminAuth, HealthRegistry, HttpRoute } from "@pikit/contracts";
import { createHealthConformance, createMemoryKeyValueStorage } from "@pikit/contracts/testing";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import healthRegistry, { graceAfter, type HealthView, MAX_REASON, VERDICTS_KEY } from "./index.ts";

// What every reporter and reader can rely on (`health`).
for (const c of createHealthConformance((policy) => ({
  components: [healthRegistry],
  config: { "health-registry": { essential: policy.essential, graceMs: policy.graceMs } },
}))) {
  test(`health-registry ${c.group}: ${c.name}`, () => c.run());
}

/** A started app with health-registry under `config`, on a manual clock. */
async function started(config: Record<string, unknown> = {}) {
  let handle: Handle<HealthRegistry> | undefined;
  const reader = defineComponent({ name: "reader-test", setup: (pikit) => void (handle = pikit.use("health")) });
  const clock = createManualClock();
  const app = await defineApp({ components: [healthRegistry, reader], config: { "health-registry": config }, clock, logger: silentLogger }).create();
  await app.start();
  if (handle === undefined) throw new Error("the reader did not set up");
  return { health: handle.get(), clock, app };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [healthRegistry], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "health-registry", provides: ["health", "http.route"], requires: [], optional: ["storage.kv", "admin.auth"] }]);
});

/**
 * A process of the App over `kv` (which outlives it, as storage does a restart), on `clock`: started,
 * with its health and a stop.
 */
async function boot(kv: ReturnType<typeof createMemoryKeyValueStorage>, clock: ManualClock, config: Record<string, unknown>) {
  let handle: Handle<HealthRegistry> | undefined;
  const storage = defineComponent({ name: "storage-test", setup: (pikit) => pikit.provide("storage.kv", kv) });
  const reader = defineComponent({ name: "reader-test", setup: (pikit) => void (handle = pikit.use("health")) });
  const app = await defineApp({ components: [storage, healthRegistry, reader], config: { "health-registry": config }, clock, logger: silentLogger }).create();
  await app.start();
  return { health: handle?.get() as HealthRegistry, stop: () => app.stop() };
}

/** How long the essential component, down from the start, takes to make the App down. */
async function downAfter(health: HealthRegistry, clock: ManualClock, step = 10_000): Promise<number> {
  health.reporter("channel-telegram").down("api.telegram.org: 502");
  let waited = 0;
  while (health.snapshot().status !== "down") {
    await clock.advance(step);
    waited += step;
  }
  return waited;
}

test("an outage a restart does not fix: each process waits twice as long before it is down, up to maxGraceMs", async () => {
  const kv = createMemoryKeyValueStorage();
  const clock = createManualClock();
  const config = { essential: ["channel-telegram"], graceMs: 30_000, maxGraceMs: 300_000 };

  const waits: number[] = [];
  for (let restart = 0; restart < 6; restart++) {
    const app = await boot(kv, clock, config);
    waits.push(await downAfter(app.health, clock));
    await app.stop();
  }

  expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  expect(await kv.namespace("health-registry").get(VERDICTS_KEY)).toBe(6);
});

test("the backoff starts over once no essential component has been down for stableMs", async () => {
  const kv = createMemoryKeyValueStorage();
  const clock = createManualClock();
  const config = { essential: ["channel-telegram"], graceMs: 30_000, stableMs: 600_000 };
  for (let restart = 0; restart < 2; restart++) {
    const app = await boot(kv, clock, config);
    await downAfter(app.health, clock);
    await app.stop();
  }

  // Telegram is back: this process waits 120 s if it goes down, but it does not.
  const calm = await boot(kv, clock, config);
  calm.health.reporter("channel-telegram").up();
  await clock.advance(599_999);
  expect(calm.health.snapshot().status).toBe("up");
  expect(await kv.namespace("health-registry").get(VERDICTS_KEY)).toBe(2);
  await clock.advance(1);
  expect(calm.health.snapshot().status).toBe("up");
  await calm.stop();
  expect(await kv.namespace("health-registry").get(VERDICTS_KEY)).toBe(0);

  // The next outage starts from graceMs again.
  const next = await boot(kv, clock, config);
  expect(await downAfter(next.health, clock)).toBe(30_000);
  await next.stop();
});

test("an essential component down for longer than stableMs is no calm: the count stays", async () => {
  const kv = createMemoryKeyValueStorage();
  const clock = createManualClock();
  const config = { essential: ["channel-telegram"], graceMs: 30_000, maxGraceMs: 3_600_000, stableMs: 60_000 };
  for (let restart = 0; restart < 3; restart++) {
    const app = await boot(kv, clock, config);
    await downAfter(app.health, clock);
    await app.stop();
  }

  const app = await boot(kv, clock, config);
  expect(await downAfter(app.health, clock)).toBe(240_000);
  await app.stop();
  expect(await kv.namespace("health-registry").get(VERDICTS_KEY)).toBe(4);
});

test("graceAfter: graceMs doubled per verdict, capped; a cap below graceMs is graceMs", () => {
  expect([0, 1, 2, 3].map((n) => graceAfter(n, 30_000, 100_000))).toEqual([30_000, 60_000, 100_000, 100_000]);
  expect(graceAfter(5, 0, 600_000)).toBe(0);
  expect(graceAfter(3, 30_000, 1_000)).toBe(30_000);
  expect(graceAfter(1_000, 30_000, 600_000)).toBe(600_000);
});

test("by default nothing is essential: a component down for long makes the App degraded only", async () => {
  const { health, clock, app } = await started();

  health.reporter("channel-telegram").down("getUpdates failed 5 times: 401");
  await clock.advance(3_600_000);

  expect(health.snapshot().status).toBe("degraded");
  await app.stop();
});

test("the grace is 30 s by default, and graceMs changes it", async () => {
  const byDefault = await started({ essential: ["channel-telegram"] });
  byDefault.health.reporter("channel-telegram").down("gone");
  await byDefault.clock.advance(29_999);
  const before = byDefault.health.snapshot().status;
  await byDefault.clock.advance(1);
  expect([before, byDefault.health.snapshot().status]).toEqual(["degraded", "down"]);
  await byDefault.app.stop();

  const immediate = await started({ essential: ["channel-telegram"], graceMs: 0 });
  immediate.health.reporter("channel-telegram").down("gone");
  expect(immediate.health.snapshot().status).toBe("down");
  await immediate.app.stop();
});

test("a long reason is cut", async () => {
  const { health, app } = await started();

  health.reporter("worker").degraded("x".repeat(MAX_REASON * 2));

  expect(health.snapshot().components[0]?.reason).toBe("x".repeat(MAX_REASON));
  await app.stop();
});

test("config is checked when the App is defined: essential is a list of names, graceMs a duration", () => {
  const define = (config: Record<string, unknown>) => () => defineApp({ components: [healthRegistry], config: { "health-registry": config }, logger: silentLogger });

  expect(define({ essential: ["channel-telegram"], graceMs: 5_000 })).not.toThrow();
  expect(define({ essential: "channel-telegram" })).toThrow("invalid config");
  expect(define({ essential: [""] })).toThrow("invalid config");
  expect(define({ graceMs: -1 })).toThrow("invalid config");
});

/** health-registry's route, with an `admin.auth` that knows one token (or none at all). */
async function route(withAuth: boolean) {
  let routes: KeyedHandle<HttpRoute> | undefined;
  let handle: Handle<HealthRegistry> | undefined;
  const auth: AdminAuth = { verify: async (request) => (request.headers.get("authorization") === "Bearer ops" ? { id: "ops" } : undefined) };
  const operators = defineComponent({ name: "auth-test", setup: (pikit) => pikit.provide("admin.auth", auth) });
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      routes = pikit.useKeyed("http.route");
      handle = pikit.use("health");
    },
  });
  const clock = createManualClock();
  const app = await defineApp({ components: [...(withAuth ? [operators] : []), healthRegistry, server], config: { "health-registry": { essential: ["channel-telegram"], graceMs: 1000 } }, clock, logger: silentLogger }).create();
  await app.start();
  const get = (headers: Record<string, string> = {}) =>
    (routes?.get("GET /admin/api/health-registry") as HttpRoute)(new Request("http://pikit.test/admin/api/health-registry", { headers }), app.context(BACKGROUND_CONTEXT));
  return { get, health: handle?.get() as HealthRegistry, clock, app };
}

test("its view's route answers an operator the snapshot and the policy it follows", async () => {
  const { get, health, clock, app } = await route(true);
  health.reporter("channel-telegram").down("getUpdates failed 5 times: 401");
  clock.advance(1000);

  const response = await get({ authorization: "Bearer ops" });
  const body = (await response.json()) as HealthView;
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ status: "down", essential: ["channel-telegram"], graceMs: 1000, downVerdicts: 0, now: clock.now() });
  expect(body.components).toEqual([{ name: "channel-telegram", status: "down", reason: "getUpdates failed 5 times: 401", since: clock.now() - 1000, essential: true }]);
  await app.stop();
});

test("its view's route answers nobody else: 401 without an operator, and without any admin.auth", async () => {
  const guarded = await route(true);
  expect((await guarded.get()).status).toBe(401);
  expect((await guarded.get({ authorization: "Bearer intruder" })).status).toBe(401);
  await guarded.app.stop();

  const open = await route(false);
  expect((await open.get({ authorization: "Bearer ops" })).status).toBe(401);
  await open.app.stop();
});
