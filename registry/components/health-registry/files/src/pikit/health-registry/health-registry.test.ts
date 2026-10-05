/**
 * health-registry's tests. They are copied with the component and keep running in your project.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, type Handle, type KeyedHandle, silentLogger } from "@pikit/core";
import type { AdminAuth, HealthRegistry, HttpRoute } from "@pikit/contracts";
import { createHealthConformance } from "@pikit/contracts/testing";
import { createManualClock } from "@pikit/core/testing";
import healthRegistry, { type HealthView, MAX_REASON } from "./index.ts";

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

  expect(app.describe().components).toEqual([{ name: "health-registry", provides: ["health", "http.route"], requires: [], optional: ["admin.auth"] }]);
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
  expect(body).toMatchObject({ status: "down", essential: ["channel-telegram"], graceMs: 1000, now: clock.now() });
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
