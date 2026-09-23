/**
 * runtime-pi's tests. They are copied with the component and keep running in your project.
 * They use `@pikit/pi-adapter/testing` for a scripted model, so they need no API key and never
 * import Pi.
 */

import { expect, test } from "bun:test";
import { defineAgent, defineApp, silentLogger } from "@pikit/core";
import { createAgentRuntimeConformance, createLifecycleConformance } from "@pikit/core/testing";
import { createPiRuntimeFixture, testComponents } from "@pikit/pi-adapter/testing";
import runtimePi, { createRuntimePi } from "./index.ts";

// The agent.runtime contract, including a worker killed mid-run (SPEC §14).
for (const c of createAgentRuntimeConformance(() => createPiRuntimeFixture(({ onHarness }) => [createRuntimePi({ onHarness })]))) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

// Start and stop honour their deadline and leave nothing open.
for (const c of createLifecycleConformance(() => {
  const { sessions, agents, provider } = testComponents();
  return { component: runtimePi, providers: [sessions, agents, provider] };
})) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const { sessions, agents, provider } = testComponents();
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  const described = app.describe().components.find((component) => component.name === "runtime-pi");

  expect(described).toMatchObject({
    provides: ["agent.runtime"],
    requires: ["sessions.store"],
    optional: ["agent.definition", "model.provider"],
  });
});

/** Why `start()` failed: the app reports the component, the cause says why. */
async function startFailure(app: { start(): Promise<void> }): Promise<string> {
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  return String(error.cause instanceof Error ? error.cause.message : error.cause);
}

test("it refuses to start without an agent", async () => {
  const { sessions, provider } = testComponents();
  const app = await defineApp({ components: [sessions, provider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain("no agent.definition");
});

test("it refuses to start when an agent names a model no provider has", async () => {
  const { sessions, agents, provider } = testComponents({
    agents: [defineAgent({ name: "support", model: "anthropic/claude-sonnet" })],
  });
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain('"anthropic/claude-sonnet"');
});
