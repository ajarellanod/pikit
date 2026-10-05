// The health suite catches a provider that breaks the contract (health-registry's own tests run it
// on the real one): no grace, or a snapshot that shares the provider's state.

import { expect, test } from "bun:test";
import { defineComponent } from "@pikit/core";
import type { ComponentHealth, HealthRegistry, HealthStatus } from "../health.ts";
import { createHealthConformance, type HealthPolicy } from "./health.ts";

/** A provider with the given flaws: `noGrace` (down at once), `shared` (the snapshot is its state). */
function flawed(policy: HealthPolicy, flaws: { noGrace?: boolean; shared?: boolean }) {
  return defineComponent({
    name: "health-flawed",
    setup(pikit) {
      const entries = new Map<string, ComponentHealth>();
      const report = (name: string, status: HealthStatus, reason?: string) => {
        const previous = entries.get(name);
        const since = previous?.status === status ? previous.since : pikit.clock.now();
        entries.set(name, { name, status, ...(reason !== undefined && { reason }), since, essential: policy.essential.includes(name) });
      };
      const registry: HealthRegistry = {
        reporter: (name) => ({ up: () => report(name, "up"), degraded: (r) => report(name, "degraded", r), down: (r) => report(name, "down", r) }),
        snapshot() {
          const components = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
          let status: HealthStatus = "up";
          for (const c of components) {
            if (c.status === "up") continue;
            const late = flaws.noGrace === true || pikit.clock.now() - c.since >= policy.graceMs;
            if (c.status === "down" && c.essential && late) status = "down";
            else if (status === "up") status = "degraded";
          }
          return { status, components: flaws.shared === true ? components : components.map((c) => ({ ...c })) };
        },
      };
      pikit.provide("health", registry);
    },
  });
}

/** The names of the cases that fail against a provider with `flaws`. */
async function failing(flaws: { noGrace?: boolean; shared?: boolean }): Promise<string[]> {
  const failed: string[] = [];
  for (const c of createHealthConformance((policy) => ({ components: [flawed(policy, flaws)] }))) {
    await c.run().catch(() => failed.push(c.name));
  }
  return failed;
}

test("a correct provider passes every case", async () => {
  expect(await failing({})).toEqual([]);
});

test("a provider without a grace fails the grace cases", async () => {
  expect(await failing({ noGrace: true })).toEqual([
    "an essential component down makes the App down only once the grace period has passed",
    "the grace counts from when it went down, and starts over after it comes back",
  ]);
});

test("a provider whose snapshot shares its state fails the copy case", async () => {
  expect(await failing({ shared: true })).toEqual(["the snapshot is JSON, and a copy: changing it changes nothing"]);
});
