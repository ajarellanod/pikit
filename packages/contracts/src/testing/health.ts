/**
 * `health` conformance: what every provider guarantees to the components that report and to the
 * readers of the snapshot (`../health.ts`). Runner-independent:
 *
 *   for (const c of createHealthConformance((policy) => myProviderFixture(policy)))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite owns the App's clock (`createManualClock`), so the grace period is checked to the
 * millisecond without waiting. The provider reads time from the App's clock (`pikit.clock`).
 */

import { type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";
import type { HealthRegistry } from "../health.ts";
import { checker, expecter } from "./assert.ts";

/** The policy a case needs: the provider is configured with it, however it takes it (config). */
export interface HealthPolicy {
  /** Component names whose `down` can make the App `down`. */
  essential: string[];
  /** How long an essential component is down before the App is. */
  graceMs: number;
}

/** A provider under test, built for one case with `policy`. */
export interface HealthFixture {
  /** The component that provides `health`, and what it uses. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  dispose?(): Promise<void>;
}

const GROUP = "health";
const expect = expecter(GROUP);
const check = checker(GROUP);

const GRACE_MS = 30_000;
const ESSENTIAL = "essential-one";
const POLICY: HealthPolicy = { essential: [ESSENTIAL, "essential-two"], graceMs: GRACE_MS };

export function createHealthConformance(factory: (policy: HealthPolicy) => HealthFixture | Promise<HealthFixture>): readonly ConformanceCase[] {
  /** A case over a started app on a manual clock, whose consumer holds `health`. */
  const healthCase = (name: string, run: (health: HealthRegistry, clock: ManualClock) => Promise<void> | void): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory({ essential: [...POLICY.essential], graceMs: POLICY.graceMs });
      const clock = createManualClock();
      let handle: Handle<HealthRegistry> | undefined;
      const consumer = defineComponent({
        name: "health-conformance",
        setup(pikit) {
          handle = pikit.use("health");
        },
      });
      const app = await defineApp({
        components: [...fixture.components, consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        clock,
        logger: silentLogger,
      }).create();
      try {
        await app.start();
        if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
        await run(handle.get(), clock);
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    healthCase("nothing reported: the App is up, and lists no component", (health) => {
      expect(health.snapshot(), { status: "up", components: [] }, "snapshot() before any report");
    }),

    healthCase("a component is listed once it reports, with its status, reason, since and whether it is essential", async (health, clock) => {
      const started = clock.now();
      health.reporter("worker-b").degraded("retrying");
      health.reporter(ESSENTIAL).up();
      await clock.advance(10);
      health.reporter("worker-a").down("connection lost");

      expect(
        health.snapshot().components,
        [
          { name: ESSENTIAL, status: "up", since: started, essential: true },
          { name: "worker-a", status: "down", reason: "connection lost", since: started + 10, essential: false },
          { name: "worker-b", status: "degraded", reason: "retrying", since: started, essential: false },
        ],
        "snapshot().components, sorted by name",
      );
      expect(health.snapshot().components[0]?.reason, undefined, "the reason of an up component");
    }),

    healthCase("the last report replaces the previous one; since moves only when the status changes", async (health, clock) => {
      const reporter = health.reporter("worker");
      const first = clock.now();
      reporter.degraded("slow");
      await clock.advance(1_000);
      reporter.degraded("slower");
      expect(health.snapshot().components, [{ name: "worker", status: "degraded", reason: "slower", since: first, essential: false }], "a new reason in the same status");

      await clock.advance(1_000);
      reporter.up();
      reporter.up();
      expect(health.snapshot().components, [{ name: "worker", status: "up", since: first + 2_000, essential: false }], "back up");
    }),

    healthCase("two reporters of one name report one component", (health, clock) => {
      health.reporter("worker").down("gone");
      health.reporter("worker").up();

      expect(health.snapshot(), { status: "up", components: [{ name: "worker", status: "up", since: clock.now(), essential: false }] }, "snapshot()");
    }),

    healthCase("a degraded component, essential or not, makes the App degraded", (health) => {
      health.reporter("worker").up();
      health.reporter(ESSENTIAL).degraded("slow");
      expect(health.snapshot().status, "degraded", "the status with an essential component degraded");

      health.reporter(ESSENTIAL).up();
      health.reporter("worker").degraded("slow");
      expect(health.snapshot().status, "degraded", "the status with another component degraded");
    }),

    healthCase("a component that is not essential down makes the App degraded, never down", async (health, clock) => {
      health.reporter("worker").down("gone");
      await clock.advance(GRACE_MS * 10);

      expect(health.snapshot().status, "degraded", "the status long after it went down");
    }),

    healthCase("an essential component down makes the App down only once the grace period has passed", async (health, clock) => {
      health.reporter(ESSENTIAL).down("gone");
      expect(health.snapshot().status, "degraded", "the status as it goes down");

      await clock.advance(GRACE_MS - 1);
      expect(health.snapshot().status, "degraded", "the status 1 ms before the grace ends");

      await clock.advance(1);
      expect(health.snapshot().status, "down", "the status when the grace ends");
      expect(health.snapshot().components[0]?.status, "down", "the component's own status");
    }),

    healthCase("the grace counts from when it went down, and starts over after it comes back", async (health, clock) => {
      const essential = health.reporter(ESSENTIAL);
      essential.degraded("slow");
      await clock.advance(GRACE_MS);
      essential.down("gone");
      expect(health.snapshot().status, "degraded", "down right after a long degradation");

      await clock.advance(GRACE_MS - 1);
      essential.up();
      expect(health.snapshot().status, "up", "the status once it is back");

      essential.down("gone again");
      await clock.advance(GRACE_MS - 1);
      expect(health.snapshot().status, "degraded", "a new outage, within its own grace");
      await clock.advance(1);
      expect(health.snapshot().status, "down", "a new outage, past its grace");
    }),

    healthCase("down outranks degraded: one essential component down past the grace makes the App down", async (health, clock) => {
      health.reporter("worker").degraded("slow");
      health.reporter("other").down("gone");
      health.reporter(ESSENTIAL).down("gone");
      health.reporter("essential-two").up();
      await clock.advance(GRACE_MS);

      expect(health.snapshot().status, "down", "the status");
    }),

    healthCase("names are matched exactly: a part of an essential component is not essential", async (health, clock) => {
      health.reporter(`${ESSENTIAL}:part`).down("gone");
      await clock.advance(GRACE_MS);

      expect(health.snapshot().status, "degraded", "the status");
      expect(health.snapshot().components[0]?.essential, false, "the part's essential flag");
    }),

    healthCase("the snapshot is JSON, and a copy: changing it changes nothing", (health) => {
      health.reporter("worker").degraded("slow");
      const snapshot = health.snapshot();
      expect(JSON.parse(JSON.stringify(snapshot)), snapshot, "the snapshot through JSON");

      snapshot.status = "down";
      if (snapshot.components[0] !== undefined) snapshot.components[0].status = "up";
      snapshot.components.push({ name: "intruder", status: "down", since: 0, essential: true });
      const after = health.snapshot();
      check(after.status === "degraded" && after.components.length === 1 && after.components[0]?.status === "degraded", "the provider's state not to change with its snapshot");
    }),
  ];
}
