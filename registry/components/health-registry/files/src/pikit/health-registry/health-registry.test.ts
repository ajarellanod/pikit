/**
 * health-registry's tests. They are copied with the component and keep running in your project.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { HealthRegistry } from "@pikit/contracts";
import { createHealthConformance } from "@pikit/contracts/testing";
import { createManualClock } from "@pikit/core/testing";
import healthRegistry, { MAX_REASON } from "./index.ts";

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

  expect(app.describe().components).toEqual([{ name: "health-registry", provides: ["health"], requires: [], optional: [] }]);
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
